// -*- coding: utf-8 -*-
/**
 * REQ 素材节点（asset-source）纯函数：素材类型识别、数据键写入、输出值读取。
 * 数据键沿用旧画布约定：image_url / video_url / audio_url（+ image / video / audio / url 镜像），文本用 prompt / text；
 * 与 kit/references.readOutputValue、后端 canvas/inputs.py 的取值口径一致。
 */

export const ASSET_SOURCE_TYPE = 'asset-source';

export type AssetSourceKind = 'image' | 'video' | 'audio' | 'text';

export const ASSET_SOURCE_KIND_LABELS: Record<AssetSourceKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
};

const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|weba|wma)(\?|#|$)/i;
const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|ogv)(\?|#|$)/i;

/** 各类型对比的数据键（主键优先，镜像键与 load-* 节点一致）。 */
const KIND_KEYS: Record<AssetSourceKind, readonly string[]> = {
  image: ['image_url', 'image'],
  video: ['video_url', 'video'],
  audio: ['audio_url', 'audio'],
  text: ['prompt', 'text'],
};

/** 所有可能被写入的素材键：换素材时要先清掉旧类型的键，避免读到上一个素材。 */
const ALL_ASSET_KEYS: readonly string[] = [
  'image_url', 'image', 'video_url', 'video', 'audio_url', 'audio', 'url', 'result_url', 'prompt', 'text',
];

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 由素材库条目推断类型：category/type 优先，文件名扩展名兜底，有正文无地址 → 文本。 */
export function assetSourceKindOf(asset: {
  category?: string; type?: string; url?: string; file_url?: string; thumb_url?: string; content?: string; visual_prompt?: string;
}): AssetSourceKind {
  const cat = (asset.category || asset.type || '').toLowerCase();
  if (cat === 'text') return 'text';
  if (cat === 'audio') return 'audio';
  if (cat === 'video') return 'video';
  const u = asset.url || asset.file_url || asset.thumb_url || '';
  if (VIDEO_EXT_RE.test(u)) return 'video';
  if (AUDIO_EXT_RE.test(u)) return 'audio';
  if (!u && (str(asset.content) || str(asset.visual_prompt))) return 'text';
  return 'image';
}

export interface AssetSourcePick {
  url?: string;
  content?: string;
  assetId?: string;
  name?: string;
}

/**
 * 选完素材写回节点 data 的补丁：清掉全部旧素材键 → 按新类型写主键 + 镜像键；
 * 同时记录 asset_id / asset_name / asset_kind，并把素材名同步为节点标题。
 */
export function assetSourcePatch(kind: AssetSourceKind, pick: AssetSourcePick): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    asset_kind: kind,
    asset_id: pick.assetId || undefined,
    asset_name: pick.name || undefined,
  };
  if (pick.name) patch.label = pick.name;
  for (const k of ALL_ASSET_KEYS) patch[k] = undefined;
  const value = kind === 'text' ? (pick.content || '') : (pick.url || '');
  for (const k of KIND_KEYS[kind]) patch[k] = value;
  if (kind !== 'text') patch.url = value;
  return patch;
}

/** 节点预览读取：类型（声明优先、键回推兜底）、显示地址、文本正文。 */
export function assetSourcePreviewOf(data: Record<string, unknown> | undefined | null): {
  kind: AssetSourceKind | ''; url: string; content: string; name: string;
} {
  const d = data || {};
  const declared = str(d.asset_kind);
  const name = str(d.asset_name);
  const content = str(d.prompt) || str(d.text);
  const url = str(d.image_url) || str(d.video_url) || str(d.audio_url) || str(d.url) || str(d.result_url);
  let kind: AssetSourceKind | '' = '';
  if (declared === 'image' || declared === 'video' || declared === 'audio' || declared === 'text') kind = declared;
  else if (url) kind = VIDEO_EXT_RE.test(url) ? 'video' : AUDIO_EXT_RE.test(url) ? 'audio' : 'image';
  else if (content) kind = 'text';
  return { kind, url, content, name };
}

/** 节点定义 outputValue：按连线推断出的目标类型直接取对应素材键（readOutputValue 的扩展点）。 */
export function assetSourceOutputValue(
  data: Record<string, unknown>,
  _portId: string,
  dataType: 'STRING' | 'IMAGE' | 'VIDEO' | 'AUDIO',
): string | undefined {
  const firstOf = (keys: readonly string[]): string | undefined => {
    for (const k of keys) {
      const v = str(data[k]);
      if (v) return v;
    }
    return undefined;
  };
  if (dataType === 'STRING') return firstOf(['prompt', 'text']);
  if (dataType === 'IMAGE') return firstOf(['image_url', 'result_url', 'file_url', 'thumb_url', 'image', 'url']);
  if (dataType === 'VIDEO') return firstOf(['video_url', 'file_url', 'video', 'url']);
  if (dataType === 'AUDIO') return firstOf(['audio_url', 'file_url', 'audio', 'url']);
  return undefined;
}
