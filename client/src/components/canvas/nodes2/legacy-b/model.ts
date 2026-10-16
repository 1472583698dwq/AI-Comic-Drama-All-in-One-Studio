// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 节点里用到的常量与纯函数（与组件文件分开，保持 Fast Refresh 边界干净）。
 */
import {
  IconBolt, IconBox, IconBoxMultiple, IconBrain, IconCode, IconCpu, IconFileText, IconMicrophone, IconMovie, IconMusic, IconPalette,
  IconPhoto, IconPhotoCog, IconPlug, IconPuzzle, IconScissors, IconSparkles, IconStack2, IconTypography, IconVideo, IconWand,
} from '@tabler/icons-react';
import type { KitIcon } from '../../kit/types';
import type { ProviderKind } from './ports';

type AnyData = Record<string, any>;

// ───────────────────────────── 灵感简报 / 剧本拆解 ─────────────────────────────

/** 画风预设（旧 BriefNode 下拉同款；不在表里的已存值也照样显示）。 */
export const STYLE_PRESETS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'donghua_xianxia', label: '国漫仙侠' },
  { id: 'japanese_anime', label: '日式二次元' },
  { id: 'modern_webtoon', label: '韩漫条漫' },
  { id: 'cinematic_3d', label: '影视3D' },
  { id: 'dark_comic', label: '暗黑漫画' },
];
export const BRIEF_RATIOS: readonly string[] = ['9:16', '16:9', '1:1'];
export const DEFAULT_STYLE = 'donghua_xianxia';
export const DEFAULT_RATIO = '9:16';

export function styleLabel(id: string): string {
  return STYLE_PRESETS.find((s) => s.id === id)?.label ?? id;
}

/** 拆解结果摘要（engine script-split 返回的 project：characters + scenes[].shots，按全部场次累计）。 */
export function scriptResultSummary(result: unknown): { characters: number; shots: number } | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as AnyData;
  const characters = Array.isArray(r.characters) ? r.characters.length : 0;
  const shots = Array.isArray(r.scenes) ? r.scenes.reduce((n: number, s: AnyData) => n + (Array.isArray(s?.shots) ? s.shots.length : 0), 0) : 0;
  return { characters, shots };
}

/** 文本下载链接（Toonflow 文本节点的「下载 .md」）。 */
export function textDownloadUrl(text: string, mime = 'text/markdown'): string | undefined {
  return text ? `data:${mime};charset=utf-8,${encodeURIComponent(text)}` : undefined;
}

// ───────────────────────────── 产出 ─────────────────────────────

/** 当前产出（视频 > 图片 > 音频，同旧 Custom / Ext 卡片）。 */
export function resultOf(data: AnyData): { url: string; kind: 'image' | 'video' | 'audio' } | null {
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  if (pick(data.video_url)) return { url: pick(data.video_url), kind: 'video' };
  if (pick(data.image_url) || pick(data.result_url)) return { url: pick(data.image_url) || pick(data.result_url), kind: 'image' };
  if (pick(data.audio_url)) return { url: pick(data.audio_url), kind: 'audio' };
  return null;
}

// ───────────────────────────── 图标 ─────────────────────────────

/** 插件声明里的 icon 是 lucide 名（如 Wand2 / Boxes）；标题栏统一用 Tabler，常见名映射过来，其余用拼图图标。 */
const LUCIDE_TO_TABLER: Readonly<Record<string, KitIcon>> = Object.freeze({
  Wand: IconWand, Wand2: IconWand, WandSparkles: IconWand, Sparkles: IconSparkles, Boxes: IconBoxMultiple, Box: IconBox,
  Image: IconPhoto, ImageIcon: IconPhoto, Images: IconPhoto, Film: IconMovie, Clapperboard: IconMovie, Video: IconVideo,
  Mic: IconMicrophone, Music: IconMusic, AudioLines: IconMusic, Scissors: IconScissors, Type: IconTypography, FileText: IconFileText,
  Code: IconCode, Code2: IconCode, Cpu: IconCpu, Layers: IconStack2, Palette: IconPalette, Zap: IconBolt, Plug: IconPlug,
  Puzzle: IconPuzzle,
});

export function extIconFor(name: unknown): KitIcon {
  return (typeof name === 'string' && LUCIDE_TO_TABLER[name]) || IconPuzzle;
}

export const PROVIDER_KIND_META: Readonly<Record<ProviderKind, { label: string; icon: KitIcon }>> = Object.freeze({
  image: { label: '生图源', icon: IconPhotoCog },
  video: { label: '视频源', icon: IconMovie },
  audio: { label: '语音源', icon: IconMicrophone },
  llm: { label: 'LLM源', icon: IconBrain },
});
