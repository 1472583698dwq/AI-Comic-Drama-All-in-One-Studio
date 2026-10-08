/**
 * 子代理集群共享元数据 — 角色标签/图标/配色 + 耗时格式化。
 * AgentSwarmPanel（会话内花名册）与成片工作室（OneKeyStudioView 的集群视图）共用，避免两处漂移。
 *
 * 动态角色：外部导演组扩展（storage/agent_profiles + 插件贡献）的 icon/color 由后端下发，
 * 通过 loadRoleMetas() 注册；图标名不在白名单时回退 Bot，配色不在白名单时回退紫色。
 */
import {
  Bot, PenLine, Palette, Image as ImageIcon, Film, Mic, Scissors, SearchCheck, Users,
  UserRound, Brush, PenTool, Camera, Clapperboard, Video, Music, AudioLines, Eye, Target,
  Sparkles, Wand2, Zap, Puzzle, Megaphone, Gamepad2, Layout, Layers,
} from 'lucide-react';

export interface RoleMeta {
  label: string;
  Icon: typeof Bot;
  /** chip 样式（边框+底色+文字色） */
  cls: string;
}

export const ROLE_META: Record<string, RoleMeta> = {
  director: { label: '总导演', Icon: Bot, cls: 'text-brand dark:text-brand-light border-brand/40 bg-brand/10' },
  screenwriter: { label: '编剧', Icon: PenLine, cls: 'text-sky-600 dark:text-sky-300 border-sky-500/30 bg-sky-500/10' },
  character_designer: { label: '角色定妆', Icon: Palette, cls: 'text-pink-600 dark:text-pink-300 border-pink-500/30 bg-pink-500/10' },
  storyboard_artist: { label: '分镜画师', Icon: ImageIcon, cls: 'text-violet-600 dark:text-violet-300 border-violet-500/30 bg-violet-500/10' },
  video_operator: { label: '动态影像', Icon: Film, cls: 'text-amber-600 dark:text-amber-300 border-amber-500/30 bg-amber-500/10' },
  voice_operator: { label: '配音', Icon: Mic, cls: 'text-emerald-600 dark:text-emerald-300 border-emerald-500/30 bg-emerald-500/10' },
  editor: { label: '剪辑', Icon: Scissors, cls: 'text-orange-600 dark:text-orange-300 border-orange-500/30 bg-orange-500/10' },
  qa_reviewer: { label: '质检', Icon: SearchCheck, cls: 'text-cyan-600 dark:text-cyan-300 border-cyan-500/30 bg-cyan-500/10' },
  generalist: { label: '通用', Icon: Users, cls: '[color:var(--color-text-main)] border-white/70 dark:border-white/12 bg-surface/80' },
};

/** 后端 icon 名 → lucide 组件（白名单，未知回退 Bot） */
const ICON_MAP: Record<string, typeof Bot> = {
  Bot, Users, UserRound, Palette, Brush, PenTool, Image: ImageIcon, Camera,
  Film, Clapperboard, Video, Mic, Music, AudioLines, Scissors,
  Search: SearchCheck, Eye, Target, Sparkles, Wand2, Zap, Puzzle, Megaphone,
  Gamepad2, Layout, Layers,
};

/** 后端 color 名 → chip 样式（白名单，未知回退紫） */
const COLOR_MAP: Record<string, string> = {
  purple: 'text-brand dark:text-brand-light border-brand/40 bg-brand/10',
  blue: 'text-sky-600 dark:text-sky-300 border-sky-500/30 bg-sky-500/10',
  green: 'text-emerald-600 dark:text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
  pink: 'text-pink-600 dark:text-pink-300 border-pink-500/30 bg-pink-500/10',
  amber: 'text-amber-600 dark:text-amber-300 border-amber-500/30 bg-amber-500/10',
  cyan: 'text-cyan-600 dark:text-cyan-300 border-cyan-500/30 bg-cyan-500/10',
  orange: 'text-orange-600 dark:text-orange-300 border-orange-500/30 bg-orange-500/10',
  red: 'text-red-600 dark:text-red-300 border-red-500/30 bg-red-500/10',
  gray: '[color:var(--color-text-main)] border-white/70 dark:border-white/12 bg-surface/80',
};

let _dynamic: Record<string, RoleMeta> = {};
let _loaded = false;
let _loading: Promise<void> | null = null;

/** 注册外部角色元数据（内置角色样式优先，不被覆盖）。 */
export function registerRoleMetas(rows: Array<{ id?: string; name?: string; icon?: string; color?: string }>): void {
  const next = { ..._dynamic };
  for (const r of rows || []) {
    const id = String(r?.id || '').trim();
    if (!id || ROLE_META[id]) continue;
    next[id] = {
      label: String(r?.name || id),
      Icon: ICON_MAP[String(r?.icon || '')] || Bot,
      cls: COLOR_MAP[String(r?.color || '')] || COLOR_MAP.purple,
    };
  }
  _dynamic = next;
}

/** 拉取后端角色目录并注册（幂等；失败静默，回退默认样式）。 */
export function loadRoleMetas(force = false): Promise<void> {
  if (_loaded && !force) return Promise.resolve();
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const { apiService } = await import('../../services/api');
      const r: any = await apiService.listAgentProfiles();
      const rows: Array<{ id?: string; name?: string; icon?: string; color?: string }> = [
        ...(r?.catalog || []),
        ...(r?.profiles || []),
      ];
      registerRoleMetas(rows);
      _loaded = true;
    } catch {
      /* 静默：保持默认样式 */
    } finally {
      _loading = null;
    }
  })();
  return _loading;
}

export function roleMeta(agent?: string): RoleMeta {
  const key = String(agent || '').trim();
  return ROLE_META[key] || _dynamic[key] || ROLE_META.generalist;
}

export function fmtElapsed(ms?: number): string {
  if (!ms || ms <= 0) return '';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}
