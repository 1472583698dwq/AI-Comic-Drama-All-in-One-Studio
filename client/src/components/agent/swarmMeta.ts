/**
 * 子代理集群共享元数据 — 角色标签/图标/配色 + 耗时格式化。
 * AgentSwarmPanel（会话内花名册）与 OneKeyRunModal（一键成片集群视图）共用，避免两处漂移。
 */
import {
  Bot, PenLine, Palette, Image as ImageIcon, Film, Mic, Scissors, SearchCheck, Users,
} from 'lucide-react';

export interface RoleMeta {
  label: string;
  Icon: typeof Bot;
  /** chip 样式（边框+底色+文字色） */
  cls: string;
}

export const ROLE_META: Record<string, RoleMeta> = {
  director: { label: '总导演', Icon: Bot, cls: 'text-brand-light border-brand/40 bg-brand/10' },
  screenwriter: { label: '编剧', Icon: PenLine, cls: 'text-sky-300 border-sky-500/30 bg-sky-500/10' },
  character_designer: { label: '角色定妆', Icon: Palette, cls: 'text-pink-300 border-pink-500/30 bg-pink-500/10' },
  storyboard_artist: { label: '分镜画师', Icon: ImageIcon, cls: 'text-violet-300 border-violet-500/30 bg-violet-500/10' },
  video_operator: { label: '动态影像', Icon: Film, cls: 'text-amber-300 border-amber-500/30 bg-amber-500/10' },
  voice_operator: { label: '配音', Icon: Mic, cls: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' },
  editor: { label: '剪辑', Icon: Scissors, cls: 'text-orange-300 border-orange-500/30 bg-orange-500/10' },
  qa_reviewer: { label: '质检', Icon: SearchCheck, cls: 'text-cyan-300 border-cyan-500/30 bg-cyan-500/10' },
  generalist: { label: '通用', Icon: Users, cls: 'text-gray-300 border-border bg-surface-secondary' },
};

export function roleMeta(agent?: string): RoleMeta {
  return ROLE_META[String(agent || '').trim()] || ROLE_META.generalist;
}

export function fmtElapsed(ms?: number): string {
  if (!ms || ms <= 0) return '';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}
