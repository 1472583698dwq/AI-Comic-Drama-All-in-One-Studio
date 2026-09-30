import {
  Home, FolderKanban, Layers, Compass, Video, Library, Users, Bot, Sparkles, Settings, Boxes, Film,
  Clapperboard,
  type LucideIcon,
} from 'lucide-react';

/**
 * 功能页图标：后端 `/pages` 给的是字符串（icon 字段，可能是 page id 也可能是 lucide 图标名），
 * 这里统一归一成 lucide 组件 —— 侧栏导航与 设置→功能开关 共用同一份映射，避免两处图标不一致。
 */

/** 归一化图标键：去掉分隔符并小写（'Folder-Kanban' / 'folderKanban' → 'folderkanban'） */
const key = (s?: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const BY_KEY: Record<string, LucideIcon> = {
  home: Home,
  house: Home, // lucide 的别名写法
  projects: FolderKanban,
  projectdashboard: FolderKanban,
  folderkanban: FolderKanban,
  kanban: FolderKanban,
  studio: Layers,
  storyboard: Layers,
  layers: Layers,
  director3d: Compass,
  director: Compass,
  stage: Compass,
  compass: Compass,
  timeline: Video,
  multitrack: Video,
  video: Video,
  characters: Users,
  character: Users,
  users: Users,
  assets: Library,
  assetlibrary: Library,
  library: Library,
  agent: Bot,
  bot: Bot,
  onekey: Clapperboard,
  onekeystudio: Clapperboard,
  clapperboard: Clapperboard,
  canvas: Sparkles,
  creativecanvas: Sparkles,
  sparkles: Sparkles,
  config: Settings,
  settings: Settings,
  film: Film,
  boxes: Boxes,
};

/** 页面 id / icon 字符串 → lucide 图标（认不出来一律回落 Boxes，绝不因图标名没见过而崩） */
export const pageIcon = (id?: string, icon?: string): LucideIcon =>
  BY_KEY[key(icon)] || BY_KEY[key(id)] || Boxes;
