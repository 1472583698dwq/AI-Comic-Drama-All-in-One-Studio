// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 旧画布迁移（design §2.3 / §4 / §7）。
 *
 * 纯函数：不依赖 React、不发请求、不修改入参（只做浅拷贝）。宿主加载画布时调用 `migrateCanvas(raw)`，
 * `changed` 为真时在第一次保存前先调备份接口。本文件不 import 任何项目模块，
 * 宿主、测试和后端兼容脚本都能直接复用（Node 22 可直接剥类型运行）。
 *
 * 做三件事：
 * 1. 被合并掉的旧类型改成新类型：text-prompt→prompt、video-legacy→video、tts→audio、
 *    asset→load-image/load-video/load-audio（按媒体字段判断）、load-image-batch→N 个 load-image（横排）。
 *    旧 data 键一个不删，只补新键（批量节点被挪走的数组放进首个节点的 `_batch.legacy`）。
 * 2. 单输入口节点（prompt/image/video/audio/director3d）的具名输入连线改连到 `in`，
 *    原槽位写进目标节点 `data.refRoles[edgeKey]`，顺序写进 `data.refOrder`。
 * 3. 生成节点（image/video/audio）没有 `data.history` 时，用现有产出 URL 起第一条历史。
 *
 * 未知类型原样保留（宿主渲染为「不支持的节点」卡片），列进 `report.unknownTypes`。
 * 幂等：`schema_version >= 2` 直接原样返回；即使 schema_version 丢了（后端存盘未保留），
 * 对已迁移过的画布再跑一次也不会再改任何东西（`changed=false`）。
 */

type AnyRecord = Record<string, any>;

// ───────────────────────────── 常量（宿主 / 后端兼容代码复用） ─────────────────────────────

/** 迁移后的画布结构版本 */
export const CANVAS_SCHEMA_VERSION = 2;

/** 新的单一输入口 id（design §4） */
export const NEW_IN_PORT = 'in';

/** 显式槽位（design §4 `refRoles` 的取值）；`prompt` 用于记录旧「提示词/文本」口 */
export type RefSlot =
  | 'prompt'
  | 'camera_prompt'
  | 'first_frame'
  | 'last_frame'
  | 'reference_images'
  | 'ref_audio'
  | 'reference_video';

/**
 * 旧具名输入口 → 槽位。不在表里的旧口名迁移时原样作为槽位名保留（多为生成源声明的插槽键），并记一条警告。
 * `video-legacy` 的 `image` 口是首帧，见 `legacySlotFor`。
 */
export const LEGACY_SLOT_MAP: Readonly<Record<string, RefSlot>> = Object.freeze({
  prompt: 'prompt',
  text: 'prompt',
  camera_prompt: 'camera_prompt',
  first_frame: 'first_frame',
  first_frame_url: 'first_frame',
  last_frame: 'last_frame',
  last_frame_url: 'last_frame',
  reference: 'reference_images',
  reference_images: 'reference_images',
  images: 'reference_images',
  image_list: 'reference_images',
  ref_audio: 'ref_audio',
  reference_audio: 'ref_audio',
  ref_audio_path: 'ref_audio',
  reference_video: 'reference_video',
} as Record<string, RefSlot>);

/** 迁移时写 refOrder 的槽位优先级（同槽位内保持旧顺序）；表外槽位排其后，无槽位的连线排最后 */
export const SLOT_PRIORITY: readonly RefSlot[] = Object.freeze([
  'prompt',
  'camera_prompt',
  'first_frame',
  'last_frame',
  'reference_images',
  'ref_audio',
  'reference_video',
] as RefSlot[]);

/** 只有一个输入口 `in` 的节点类型（design §6.1；group 无端口） */
export const IN_PORT_NODE_TYPES: readonly string[] = Object.freeze(['prompt', 'image', 'video', 'audio', 'director3d']);

/** 生成节点：迁移时补 `data.history` */
export const GENERATION_NODE_TYPES: readonly string[] = Object.freeze(['image', 'video', 'audio']);

/**
 * 节点类型 → 主输出口 id。新节点沿用旧输出口 id（与 MinimalNodes / LoaderNodes 一致）：
 * 文本节点输出口仍是 `prompt`（存量 18 条连线都用它），3D 导演仍是 `camera_prompt`。
 */
export const PRIMARY_OUTPUT_PORT: Readonly<Record<string, string>> = Object.freeze({
  prompt: 'prompt',
  image: 'image',
  video: 'video',
  audio: 'audio',
  director3d: 'camera_prompt',
  'load-image': 'image',
  'load-video': 'video',
  'load-audio': 'audio',
});

/** 生成源节点：连到生成节点的线不改（provider 节点保留，design §2.4） */
export const PROVIDER_NODE_TYPES: readonly string[] = Object.freeze([
  'provider',
  'provider-image',
  'provider-video',
  'provider-audio',
  'provider-llm',
]);

/** 一对一改类型的旧节点（asset 按媒体判断、load-image-batch 拆分，单独处理） */
export const LEGACY_TYPE_MAP: Readonly<Record<string, string>> = Object.freeze({
  'text-prompt': 'prompt',
  'video-legacy': 'video',
  tts: 'audio',
});

/** 会被迁移掉的旧类型 */
export const LEGACY_NODE_TYPES: readonly string[] = Object.freeze([
  'text-prompt',
  'video-legacy',
  'tts',
  'asset',
  'load-image-batch',
]);

/** 迁移后仍有效的节点类型（核心 + 独有 + 新增 group）；其余一律视为未知类型 */
export const CURRENT_NODE_TYPES: readonly string[] = Object.freeze([
  'prompt',
  'image',
  'video',
  'audio',
  'director3d',
  'load-image',
  'load-video',
  'load-audio',
  'group',
  'export',
  'timeline',
  'timeline-export',
  'shot-card',
  'comfy-workflow',
  'brief',
  'script-split',
  'custom',
  'ext-node',
  ...PROVIDER_NODE_TYPES,
]);

/** 批量图片拆分后每张卡的横向间距：加载图片卡默认宽（同 autoLayout 的 EST['load-image']）+ 40 */
export const LOAD_IMAGE_WIDTH = 260;
export const BATCH_SPLIT_SPACING = LOAD_IMAGE_WIDTH + 40;

/** 旧组件输出口别名（AssetNode.tsx 里的老 Director3DNode 输出口叫 camera） */
const SOURCE_HANDLE_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  director3d: Object.freeze({ camera: 'camera_prompt' }),
});

// ───────────────────────────── 类型 ─────────────────────────────

export interface CanvasNodeLike {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data?: AnyRecord;
  [k: string]: any;
}

export interface CanvasEdgeLike {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  [k: string]: any;
}

export interface RawCanvas {
  nodes?: CanvasNodeLike[];
  edges?: CanvasEdgeLike[];
  viewport?: any;
  schema_version?: number;
  [k: string]: any;
}

export interface MigratedCanvas extends RawCanvas {
  nodes: CanvasNodeLike[];
  edges: CanvasEdgeLike[];
  schema_version: number;
}

/** 生成历史条目（design §4 `data.history`）；迁移起的那条只有已知字段 */
export interface HistoryEntry {
  url: string;
  created_at?: string;
  provider_id?: string;
  params?: AnyRecord;
}

export interface MigrateReport {
  /** `旧类型->新类型` → 被转换的原节点数 */
  converted: Record<string, number>;
  /** 改连到 `in` 的连线数（不含因重复被合并掉的） */
  rewiredEdges: number;
  /** 未知节点类型（原样保留） */
  unknownTypes: string[];
  warnings: string[];
  /** 连到生成源口 / 从生成源节点出发、原样保留的连线数 */
  providerEdges: number;
  /** 改连 `in` 后与同一来源重复、被合并掉的连线 id（槽位信息见 warnings） */
  droppedEdges: string[];
  /** 拆分批量图片新建的节点 id */
  createdNodes: string[];
}

export interface MigrateResult {
  canvas: MigratedCanvas;
  changed: boolean;
  report: MigrateReport;
}

// ───────────────────────────── 小工具 ─────────────────────────────

const absent = (v: unknown): boolean => v === undefined || v === null || v === '';
const firstPresent = (...vals: unknown[]): unknown => vals.find((v) => !absent(v));
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPlainObject = (v: unknown): v is AnyRecord => !!v && typeof v === 'object' && !Array.isArray(v);
const isNode = (n: unknown): n is CanvasNodeLike => isPlainObject(n) && typeof (n as AnyRecord).id === 'string';
const isEdge = (e: unknown): e is CanvasEdgeLike =>
  isPlainObject(e) && typeof (e as AnyRecord).source === 'string' && typeof (e as AnyRecord).target === 'string';

/** 只在 key 缺失（undefined/null/''）且 value 有值时写入，绝不覆盖已有数据 */
function fill(data: AnyRecord, key: string, value: unknown): void {
  if (absent(data[key]) && !absent(value)) data[key] = value;
}

function emptyReport(): MigrateReport {
  return { converted: {}, rewiredEdges: 0, unknownTypes: [], warnings: [], providerEdges: 0, droppedEdges: [], createdNodes: [] };
}

// ───────────────────────────── 导出的辅助函数 ─────────────────────────────

/** 参考项的键：`sourceId|sourceHandle`（design §4），refOrder / refRoles 都以它为键 */
export function edgeKey(edge: { source: string; sourceHandle?: string | null }): string;
export function edgeKey(source: string, sourceHandle?: string | null): string;
export function edgeKey(a: string | { source: string; sourceHandle?: string | null }, sourceHandle?: string | null): string {
  if (typeof a === 'string') return `${a}|${sourceHandle ?? ''}`;
  return `${a.source}|${a.sourceHandle ?? ''}`;
}

/**
 * 旧具名输入口 → 槽位名。`in`、`provider`、空句柄返回 undefined（不指定槽位，按模式自动分配）。
 * `targetType` 传旧节点类型：`video-legacy` 的 `image` 口是首帧。表外口名原样返回。
 */
export function legacySlotFor(handle: string | null | undefined, targetType?: string): string | undefined {
  if (!handle || handle === NEW_IN_PORT || handle === 'provider') return undefined;
  if (targetType === 'video-legacy' && handle === 'image') return 'first_frame';
  return LEGACY_SLOT_MAP[handle] ?? handle;
}

/**
 * 连线兼容（宿主 / Agent 连线复用）：目标是单输入口节点、且句柄不是 `in` 时，返回改连目标与槽位；
 * 其余情况（非单输入口节点、生成源口、来自生成源节点）返回 null，表示原样保留。
 * `targetType` 可传旧类型（如 tts、video-legacy），会先换算成新类型。
 */
export function toInPort(
  targetType: string | undefined,
  targetHandle: string | null | undefined,
  sourceType?: string,
): { targetHandle: string; role?: string } | null {
  const t = targetType ? LEGACY_TYPE_MAP[targetType] ?? targetType : '';
  if (!IN_PORT_NODE_TYPES.includes(t)) return null;
  if (targetHandle === NEW_IN_PORT || targetHandle === 'provider') return null;
  if (sourceType && PROVIDER_NODE_TYPES.includes(sourceType)) return null;
  const role = legacySlotFor(targetHandle, targetType);
  return role ? { targetHandle: NEW_IN_PORT, role } : { targetHandle: NEW_IN_PORT };
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|avi)(?:[?#]|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac|aac|opus)(?:[?#]|$)/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#]|$)/i;
const IMAGE_CATEGORIES = ['character', 'scene', 'prop', 'background', 'effect', 'ui', 'previz'];

/**
 * 素材节点的媒体类型：先看 image_url/video_url/audio_url，再看类型字段，再看文件扩展名，
 * 再看图片类素材分类；都判断不出返回 undefined。
 */
export function detectAssetMediaKind(data: AnyRecord | undefined | null): 'image' | 'video' | 'audio' | undefined {
  if (!isPlainObject(data)) return undefined;
  if (isStr(data.video_url)) return 'video';
  if (isStr(data.audio_url)) return 'audio';
  if (isStr(data.image_url)) return 'image';
  for (const k of ['media_type', 'asset_type', 'mime_type', 'kind', 'type']) {
    const v = data[k];
    if (!isStr(v)) continue;
    const s = v.toLowerCase();
    if (s.startsWith('video')) return 'video';
    if (/^(audio|voice|sound|music|bgm)/.test(s)) return 'audio';
    if (/^(image|picture|photo)/.test(s)) return 'image';
  }
  for (const k of ['file_url', 'url', 'file_path', 'path']) {
    const v = data[k];
    if (!isStr(v)) continue;
    if (VIDEO_EXT.test(v)) return 'video';
    if (AUDIO_EXT.test(v)) return 'audio';
    if (IMAGE_EXT.test(v)) return 'image';
  }
  if (isStr(data.thumb_url)) return 'image';
  if (isStr(data.category) && IMAGE_CATEGORIES.includes(data.category)) return 'image';
  return undefined;
}

// ───────────────────────────── 节点转换 ─────────────────────────────

interface Ctx {
  report: MigrateReport;
  usedNodeIds: Set<string>;
  usedEdgeIds: Set<string>;
}

const warn = (ctx: Ctx, msg: string) => ctx.report.warnings.push(msg);
const countConverted = (ctx: Ctx, from: string, to: string) => {
  const k = `${from}->${to}`;
  ctx.report.converted[k] = (ctx.report.converted[k] || 0) + 1;
};
function uniqueId(used: Set<string>, base: string): string {
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
  used.add(id);
  return id;
}

// REQ-toonflow-canvas text-prompt → prompt：prompt / text 互补（两边都有且不同则都保留）
function convertTextPrompt(node: CanvasNodeLike, ctx: Ctx): CanvasNodeLike {
  const data: AnyRecord = { ...(node.data || {}) };
  if (absent(data.prompt) && !absent(data.text)) data.prompt = data.text;
  else if (absent(data.text) && !absent(data.prompt)) data.text = data.prompt;
  else if (!absent(data.prompt) && !absent(data.text) && data.prompt !== data.text) {
    warn(ctx, `节点 ${node.id}（text-prompt）的 prompt 与 text 内容不同，两者都已保留`);
  }
  data._migrated_from = 'text-prompt';
  countConverted(ctx, 'text-prompt', 'prompt');
  return { ...node, type: 'prompt', data };
}

// REQ-toonflow-canvas video-legacy → video：补 prompt / first_frame / provider_id 等 MiniMax 现有键
function convertVideoLegacy(node: CanvasNodeLike, ctx: Ctx): CanvasNodeLike {
  const data: AnyRecord = { ...(node.data || {}) };
  fill(data, 'prompt', data.video_prompt);
  fill(data, 'first_frame', firstPresent(data.first_frame_url, data.image_url));
  const prov = firstPresent(data.provider_id, data.provider, data.provider_video);
  fill(data, 'provider_id', prov);
  fill(data, 'provider', prov);
  data._migrated_from = 'video-legacy';
  countConverted(ctx, 'video-legacy', 'video');
  return { ...node, type: 'video', data };
}

// REQ-toonflow-canvas tts → audio：台词/音色/情感/语音源对齐 audio 节点（MinimalNodes AudioNode + nodeAgentExecutor）的键
function convertTts(node: CanvasNodeLike, ctx: Ctx): CanvasNodeLike {
  const data: AnyRecord = { ...(node.data || {}) };
  fill(data, 'text', firstPresent(data.dialogue, data.subtitle_text, data.brief));
  fill(data, 'prompt', data.text);
  const prov = firstPresent(data.provider_id, data.provider, data.provider_audio, data.audio_provider);
  fill(data, 'provider_id', prov);
  fill(data, 'provider', prov);
  fill(data, 'voice_id', data.voice);
  fill(data, 'ref_audio', firstPresent(data.reference_audio, data.ref_audio_path));
  data._migrated_from = 'tts';
  countConverted(ctx, 'tts', 'audio');
  return { ...node, type: 'audio', data };
}

// REQ-toonflow-canvas asset → load-image / load-video / load-audio（按媒体字段判断，判断不出按图片并告警）
function convertAsset(node: CanvasNodeLike, ctx: Ctx): CanvasNodeLike {
  const data: AnyRecord = { ...(node.data || {}) };
  let kind = detectAssetMediaKind(data);
  if (!kind) {
    kind = 'image';
    warn(ctx, `素材节点 ${node.id} 判断不出媒体类型，按图片迁移为 load-image`);
  }
  const url = firstPresent(data[`${kind}_url`], data.file_url, data.url, kind === 'image' ? data.thumb_url : undefined);
  fill(data, kind, url);
  fill(data, 'url', url);
  fill(data, `${kind}_url`, url);
  data._migrated_from = 'asset';
  const type = `load-${kind}`;
  countConverted(ctx, 'asset', type);
  return { ...node, type, data };
}

const BATCH_MOVED_KEYS = ['images', 'image_list', 'image', 'url', 'image_url'];

// REQ-toonflow-canvas load-image-batch → N 个 load-image：首张沿用原 id，其余 `${id}__${i}`，横向间距 = 卡宽 + 40
function splitBatch(node: CanvasNodeLike, ctx: Ctx): CanvasNodeLike[] {
  const data: AnyRecord = node.data || {};
  const list = Array.isArray(data.images) && data.images.length ? data.images : Array.isArray(data.image_list) ? data.image_list : [];
  const urls: string[] = list.filter(isStr);
  const total = urls.length;
  const n = Math.max(1, total);
  const legacy: AnyRecord = {};
  const rest: AnyRecord = { ...data };
  for (const k of BATCH_MOVED_KEYS) {
    if (k in data) legacy[k] = data[k];
    delete rest[k];
  }
  // 节点级的测量/选中态不带到拆出的卡上（React Flow 会重新测量）
  const { measured: _m, width: _w, height: _h, selected: _s, dragging: _d, ...nodeRest } = node;
  const x0 = Number(node.position?.x) || 0;
  const y0 = Number(node.position?.y) || 0;
  const out: CanvasNodeLike[] = [];
  for (let i = 0; i < n; i++) {
    const id = i === 0 ? node.id : uniqueId(ctx.usedNodeIds, `${node.id}__${i}`);
    const d: AnyRecord = {
      ...rest,
      _migrated_from: 'load-image-batch',
      _batch: i === 0 ? { from: node.id, index: 0, total, legacy } : { from: node.id, index: i, total },
    };
    const url = urls[i];
    if (url) {
      d.image = url;
      d.url = url;
      d.image_url = url;
    }
    out.push({ ...nodeRest, id, type: 'load-image', position: { x: x0 + i * BATCH_SPLIT_SPACING, y: y0 }, data: d });
    if (i > 0) ctx.report.createdNodes.push(id);
  }
  if (total !== 1) warn(ctx, `批量图片节点 ${node.id} 拆成 ${n} 个图片节点${total ? '' : '（原节点没有图片）'}`);
  countConverted(ctx, 'load-image-batch', 'load-image');
  return out;
}

// ───────────────────────────── 主函数 ─────────────────────────────

/** 源节点上可能出现在目标多值槽数组里的 URL（用于同槽位内保持旧顺序） */
function mediaUrlsOf(data: AnyRecord | undefined): string[] {
  if (!data) return [];
  return ['image_url', 'result_url', 'image', 'url', 'file_url', 'video_url', 'audio_url'].map((k) => data[k]).filter(isStr);
}

interface Pending {
  idx: number; // work 下标
  key: string;
  role?: string;
  oldHandle: string | null;
  order: number; // 原连线顺序
}

export function migrateCanvas(raw: RawCanvas | null | undefined): MigrateResult {
  const report = emptyReport();
  const src: RawCanvas = isPlainObject(raw) ? raw : {};

  // 幂等：已是新结构，原样返回
  if (Number(src.schema_version) >= CANVAS_SCHEMA_VERSION) {
    const canvas = (Array.isArray(src.nodes) && Array.isArray(src.edges)
      ? src
      : { ...src, nodes: Array.isArray(src.nodes) ? src.nodes : [], edges: Array.isArray(src.edges) ? src.edges : [] }) as MigratedCanvas;
    return { canvas, changed: false, report };
  }

  const inNodes: unknown[] = Array.isArray(src.nodes) ? src.nodes : [];
  const inEdges: unknown[] = Array.isArray(src.edges) ? src.edges : [];
  const ctx: Ctx = {
    report,
    usedNodeIds: new Set(inNodes.filter(isNode).map((n) => n.id)),
    usedEdgeIds: new Set(inEdges.filter(isEdge).map((e) => e.id)),
  };
  let changed = false;

  // ── 1. 节点：旧类型转换 / 批量拆分 / 未知类型登记 ──
  const outNodes: any[] = [];
  const oldTypeOf = new Map<string, string>();
  const newTypeOf = new Map<string, string>();
  const splitIds = new Map<string, string[]>();
  const unknown = new Set<string>();
  for (const node of inNodes) {
    if (!isNode(node)) {
      outNodes.push(node);
      warn(ctx, '跳过一个没有 id 的节点（原样保留）');
      continue;
    }
    const type = node.type || 'default';
    let produced: CanvasNodeLike[];
    switch (type) {
      case 'text-prompt':
        produced = [convertTextPrompt(node, ctx)];
        break;
      case 'video-legacy':
        produced = [convertVideoLegacy(node, ctx)];
        break;
      case 'tts':
        produced = [convertTts(node, ctx)];
        break;
      case 'asset':
        produced = [convertAsset(node, ctx)];
        break;
      case 'load-image-batch':
        produced = splitBatch(node, ctx);
        splitIds.set(node.id, produced.map((p) => p.id));
        break;
      default:
        produced = [node];
        if (!CURRENT_NODE_TYPES.includes(type)) unknown.add(type);
    }
    if (produced.length !== 1 || produced[0] !== node) changed = true;
    for (const p of produced) {
      oldTypeOf.set(p.id, type);
      newTypeOf.set(p.id, p.type || 'default');
      outNodes.push(p);
    }
  }
  report.unknownTypes = [...unknown];
  if (unknown.size) warn(ctx, `未知节点类型原样保留：${report.unknownTypes.join('、')}`);
  const nodeIndex = new Map<string, number>();
  outNodes.forEach((n, i) => {
    if (isNode(n)) nodeIndex.set(n.id, i);
  });

  // ── 2. 连线：批量节点出边按拆分复制 ──
  const expanded: unknown[] = [];
  for (const e of inEdges) {
    const ids = isEdge(e) ? splitIds.get(e.source) : undefined;
    if (!isEdge(e) || !ids) {
      expanded.push(e);
      continue;
    }
    ids.forEach((sid, i) => {
      const id = i === 0 ? e.id : uniqueId(ctx.usedEdgeIds, `${e.id}__${i}`);
      expanded.push({ ...e, id, source: sid, sourceHandle: PRIMARY_OUTPUT_PORT['load-image'] });
    });
    changed = true;
  }

  // ── 3. 连线：源口归一 + 具名输入口改连 `in` ──
  const work: Array<{ edge: any; drop?: boolean }> = [];
  const pendingByTarget = new Map<string, Pending[]>();
  const preInKeys = new Map<string, Array<{ key: string; id: string }>>();
  expanded.forEach((e0, order) => {
    if (!isEdge(e0)) {
      work.push({ edge: e0 });
      return;
    }
    let e: CanvasEdgeLike = e0;
    const srcOld = oldTypeOf.get(e.source);
    const srcNew = newTypeOf.get(e.source);
    const tgtOld = oldTypeOf.get(e.target);
    const tgtNew = newTypeOf.get(e.target);
    if (srcNew === undefined || tgtNew === undefined) {
      warn(ctx, `连线 ${e.id} 的${srcNew === undefined ? '起点' : '终点'}节点不存在，原样保留`);
      work.push({ edge: e });
      return;
    }

    // 源口：被合并的旧类型只剩一个输出口；旧组件的输出口别名
    if (srcOld && LEGACY_NODE_TYPES.includes(srcOld)) {
      const port = PRIMARY_OUTPUT_PORT[srcNew];
      if (port && e.sourceHandle !== port) e = { ...e, sourceHandle: port };
    } else {
      const alias = isStr(e.sourceHandle) ? SOURCE_HANDLE_ALIASES[srcNew]?.[e.sourceHandle] : undefined;
      if (alias) e = { ...e, sourceHandle: alias };
    }

    // 目标口
    if (IN_PORT_NODE_TYPES.includes(tgtNew)) {
      if (e.targetHandle === NEW_IN_PORT) {
        if (!preInKeys.has(e.target)) preInKeys.set(e.target, []);
        preInKeys.get(e.target)!.push({ key: edgeKey(e), id: e.id });
      } else if (e.targetHandle === 'provider' || PROVIDER_NODE_TYPES.includes(srcNew)) {
        report.providerEdges++;
        warn(ctx, `连线 ${e.id} 是生成源连线（${e.source} → ${e.target}.${e.targetHandle ?? '默认口'}），原样保留`);
      } else {
        const oldHandle = e.targetHandle ?? null;
        const role = legacySlotFor(oldHandle, tgtOld);
        if (absent(e.sourceHandle) && PRIMARY_OUTPUT_PORT[srcNew]) e = { ...e, sourceHandle: PRIMARY_OUTPUT_PORT[srcNew] };
        e = { ...e, targetHandle: NEW_IN_PORT };
        if (role && !(SLOT_PRIORITY as readonly string[]).includes(role)) {
          warn(ctx, `连线 ${e.id} 的旧输入口「${oldHandle}」不是已知槽位，已原样记为槽位名`);
        }
        if (!pendingByTarget.has(e.target)) pendingByTarget.set(e.target, []);
        pendingByTarget.get(e.target)!.push({ idx: work.length, key: edgeKey(e), role, oldHandle, order });
      }
    }
    if (e !== e0) changed = true;
    work.push({ edge: e });
  });

  // ── 4. 目标节点：refRoles / refOrder；同一来源重复的连线合并 ──
  const rank = (role?: string) => {
    if (role === undefined) return SLOT_PRIORITY.length + 1;
    const i = (SLOT_PRIORITY as readonly string[]).indexOf(role);
    return i >= 0 ? i : SLOT_PRIORITY.length;
  };
  for (const [tid, list] of pendingByTarget) {
    const ni = nodeIndex.get(tid);
    if (ni === undefined) continue;
    const tnode = outNodes[ni] as CanvasNodeLike;
    const data: AnyRecord = { ...(tnode.data || {}) };
    // 多值槽（参考集）按目标节点里旧数组的顺序排，其余按原连线顺序
    const posInSlot = (p: Pending): number => {
      const arr = (p.oldHandle && Array.isArray(data[p.oldHandle]) ? data[p.oldHandle] : p.role && Array.isArray(data[p.role]) ? data[p.role] : null) as unknown[] | null;
      if (!arr) return Number.POSITIVE_INFINITY;
      const srcId = work[p.idx].edge.source;
      const sn = outNodes[nodeIndex.get(srcId) ?? -1] as CanvasNodeLike | undefined;
      const hits = mediaUrlsOf(sn?.data).map((u) => arr.indexOf(u)).filter((i) => i >= 0);
      return hits.length ? Math.min(...hits) : Number.POSITIVE_INFINITY;
    };
    const sorted = [...list].sort((a, b) => rank(a.role) - rank(b.role) || posInSlot(a) - posInSlot(b) || a.order - b.order);

    const refOrder: unknown[] = Array.isArray(data.refOrder) ? [...data.refOrder] : [];
    const inOrder = new Set(refOrder.filter(isStr));
    const taken = new Map<string, string>();
    for (const { key, id } of preInKeys.get(tid) || []) {
      if (!taken.has(key)) taken.set(key, id);
      if (!inOrder.has(key)) {
        refOrder.push(key);
        inOrder.add(key);
      }
    }
    const refRoles: AnyRecord = isPlainObject(data.refRoles) ? { ...data.refRoles } : {};
    for (const p of sorted) {
      const w = work[p.idx];
      const keeper = taken.get(p.key);
      if (keeper !== undefined) {
        w.drop = true;
        report.droppedEdges.push(w.edge.id);
        warn(ctx, `连线 ${w.edge.id}（旧口 ${p.oldHandle ?? '默认口'}）与 ${keeper} 来自同一输出口，改连 in 后合并为一条`);
        continue;
      }
      taken.set(p.key, w.edge.id);
      if (p.role && refRoles[p.key] === undefined) refRoles[p.key] = p.role;
      if (!inOrder.has(p.key)) {
        refOrder.push(p.key);
        inOrder.add(p.key);
      }
      report.rewiredEdges++;
    }
    data.refOrder = refOrder;
    if (Object.keys(refRoles).length) data.refRoles = refRoles;
    outNodes[ni] = { ...tnode, data };
    changed = true;
  }

  // ── 5. 生成节点：用现有产出起第一条历史 ──
  const HISTORY_URL_KEYS: Record<string, string[]> = {
    image: ['image_url', 'result_url'],
    video: ['video_url'],
    audio: ['audio_url', 'result_url'],
  };
  outNodes.forEach((n, i) => {
    if (!isNode(n) || !GENERATION_NODE_TYPES.includes(n.type || '')) return;
    const d = n.data;
    if (!isPlainObject(d) || (d.history !== undefined && d.history !== null)) return;
    const url = HISTORY_URL_KEYS[n.type!].map((k) => d[k]).find(isStr);
    if (!url) return;
    const entry: HistoryEntry = { url };
    const st = isPlainObject(d.agent_state) ? d.agent_state : undefined;
    if (isStr(st?.updated_at)) entry.created_at = st!.updated_at;
    const prov = firstPresent(d.provider_id, d.provider, st?.provider_id);
    if (isStr(prov)) entry.provider_id = prov;
    outNodes[i] = { ...n, data: { ...d, history: [entry] } };
    changed = true;
  });

  const canvas: MigratedCanvas = {
    ...src,
    nodes: outNodes,
    edges: work.filter((w) => !w.drop).map((w) => w.edge),
    schema_version: CANVAS_SCHEMA_VERSION,
  };
  return { canvas, changed, report };
}
