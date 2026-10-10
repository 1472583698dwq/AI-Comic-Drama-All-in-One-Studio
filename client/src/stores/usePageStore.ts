import { create } from 'zustand';
import { apiService } from '../services/api';

/**
 * 功能页（page）运行时开关。
 *
 * 数据源唯一：后端 `GET /api/v1/pages`（契约冻结），写入走
 * `POST /api/v1/extensions/page:<id>/enable|disable`。
 * 后端关闭某个 page 后，对应能力族的接口会直接 404（studio/director3d → 分镜与一键成片；
 * canvas → 画布与自定义节点），`config` 为 locked 系统页不可关闭。
 *
 * 前端只用它做两件事：
 *   1) 页签准入 —— resolveTab() 决定「当前该渲染哪一页」，关掉的页永远进不去；
 *   2) 入口可见性 —— 侧栏分组 / 设置页开关面板按 enabled 渲染。
 * 不缓存到 localStorage：页面开关的真相只有后端一份，避免本地与后端漂移。
 */

export interface PageItem {
  id: string;
  label: string;
  /** 契约给的图标键（可能是 id 也可能是 lucide 名），由 pageIcons 映射 */
  icon?: string;
  /** 分组键（后端 groups 里描述顺序与名称） */
  group?: string;
  order: number;
  /** 内置默认值（后端标记的出厂态），仅作展示参考 */
  default?: boolean;
  /** 系统页：不可关闭 */
  locked?: boolean;
  /** host 键 → 前端组件（App.PAGE_HOSTS） */
  host?: string;
  api_families?: string[];
  description?: string;
  enabled: boolean;
}

export interface PageGroupMeta {
  id: string;
  label: string;
  order: number;
}

interface PageState {
  items: PageItem[];
  values: Record<string, boolean>;
  groups: PageGroupMeta[];
  /** 开关落盘位置（后端返回，设置面板脚注用） */
  file: string;
  loaded: boolean;
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  setPage: (id: string, enabled: boolean) => Promise<void>;
}

/**
 * 兜底默认集：**仅在 `/pages` 请求失败时**启用（后端未就绪 / 网络异常），
 * 免得一次读配置失败就让整站显示「没有开启任何功能页」。
 * 后端返回 200 但 pages 为空时**不**兜底 —— 那是后端的真实状态（此时应显示空态页）。
 * 内容与契约里的内置默认集一致：开 = home/assets/characters/agent/canvas/config。
 */
const FALLBACK_PAGES: PageItem[] = [
  { id: 'home', label: '首页', icon: 'home', group: '工作区', order: 10, enabled: true, host: 'home' },
  { id: 'projects', label: '项目看板', icon: 'folder-kanban', group: '工作区', order: 20, enabled: true, host: 'projects' },
  { id: 'assets', label: '素材库', icon: 'library', group: '工作区', order: 30, enabled: true, host: 'assets' },
  { id: 'characters', label: '角色设定', icon: 'users', group: '工作区', order: 40, enabled: true, host: 'characters' },
  { id: 'studio', label: '分镜台', icon: 'layers', group: '漫剧工坊', order: 50, enabled: true, host: 'studio' },
  { id: 'onekey', label: '成片工作室', icon: 'clapperboard', group: '漫剧工坊', order: 55, enabled: true, host: 'onekey' },
  { id: 'director3d', label: '3D 片场', icon: 'compass', group: '漫剧工坊', order: 60, enabled: true, host: 'director3d' },
  { id: 'timeline', label: '多轨剪辑', icon: 'video', group: '漫剧工坊', order: 70, enabled: true, host: 'timeline' },
  { id: 'agent', label: 'AI 导演', icon: 'bot', group: '创意工坊', order: 80, enabled: true, host: 'agent' },
  { id: 'canvas', label: '创意画布', icon: 'sparkles', group: '创意工坊', order: 90, enabled: true, host: 'canvas' },
  { id: 'config', label: '设置', icon: 'settings', group: '系统', order: 999, enabled: true, host: 'config', locked: true },
];

/** 分组 id 用后端 PAGE_DEFS 里的中文分组名（后端 groups 也是这些名字），避免两套键名漂移 */
const FALLBACK_GROUPS: PageGroupMeta[] = [
  { id: '工作区', label: '工作区', order: 10 },
  { id: '漫剧工坊', label: '漫剧工坊', order: 20 },
  { id: '创意工坊', label: '创意工坊', order: 30 },
  { id: '系统', label: '系统', order: 40 },
];

const asOrder = (v: any, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** 归一化契约返回：items 按 order 排序，enabled 以 values 为准（values 缺失才回落到 item.enabled） */
function normalizeItems(raw: any): PageItem[] {
  const list: any[] = Array.isArray(raw?.pages) ? raw.pages : Array.isArray(raw) ? raw : [];
  const values: Record<string, any> = raw?.values && typeof raw.values === 'object' ? raw.values : {};
  return list
    .filter((p) => p && typeof p.id === 'string' && p.id)
    .map((p, i) => ({
      id: p.id,
      label: typeof p.label === 'string' && p.label ? p.label : p.id,
      icon: typeof p.icon === 'string' ? p.icon : undefined,
      group: typeof p.group === 'string' ? p.group : '',
      order: asOrder(p.order, i),
      default: !!p.default,
      locked: !!p.locked,
      host: typeof p.host === 'string' && p.host ? p.host : p.id,
      api_families: Array.isArray(p.api_families) ? p.api_families : [],
      description: typeof p.description === 'string' ? p.description : '',
      enabled: values[p.id] !== undefined ? !!values[p.id] : !!p.enabled,
    }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

const valuesOf = (items: PageItem[]): Record<string, boolean> =>
  items.reduce<Record<string, boolean>>((acc, it) => { acc[it.id] = it.enabled; return acc; }, {});

/** 分组元数据：优先用后端 groups；缺元数据的分组按页面出现顺序补位（label 回落到组键） */
function normalizeGroups(raw: any, items: PageItem[]): PageGroupMeta[] {
  const out: PageGroupMeta[] = [];
  const seen = new Set<string>();
  const src: any[] = Array.isArray(raw?.groups) ? raw.groups : [];
  src.forEach((g, i) => {
    const id = typeof g === 'string' ? g : String(g?.id ?? g?.key ?? g?.group ?? g?.name ?? '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      label: typeof g === 'string' ? g : String(g?.label ?? g?.title ?? g?.name ?? id),
      order: asOrder(g?.order ?? g?.sort, i),
    });
  });
  items.forEach((it) => {
    if (!it.group || seen.has(it.group)) return;
    seen.add(it.group);
    out.push({ id: it.group, label: it.group, order: out.length });
  });
  return out.sort((a, b) => a.order - b.order);
}

export const usePageStore = create<PageState>((set, get) => ({
  items: [],
  values: {},
  groups: [],
  file: '',
  loaded: false,
  loading: false,
  error: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const res = await apiService.getPages();
      const items = normalizeItems(res);
      set({
        items,
        values: valuesOf(items),
        groups: normalizeGroups(res, items),
        file: String(res?.file || ''),
        loaded: true,
        loading: false,
      });
    } catch (e: any) {
      const items = FALLBACK_PAGES.map((it) => ({ ...it }));
      set({
        items,
        values: valuesOf(items),
        groups: FALLBACK_GROUPS.map((g) => ({ ...g })),
        loaded: true,
        loading: false,
        error: e?.message || '读取功能页开关失败',
      });
    }
  },

  /** 写后端成功后以返回值为准刷新本地（后端可能纠正值，如拒绝停用 config） */
  setPage: async (id, enabled) => {
    const res: any = await apiService.setPageEnabled(id, enabled);
    const items = normalizeItems(res);
    if (items.length > 0) {
      set({
        items,
        values: valuesOf(items),
        groups: normalizeGroups(res, items),
        file: String(res?.file || get().file || ''),
        error: null,
      });
      return;
    }
    // 后端只回 values（或空体）时，按本地补丁更新，保持两侧一致
    const serverValues: Record<string, any> = res?.values && typeof res.values === 'object' ? res.values : {};
    const nextValues = { ...get().values, [id]: enabled, ...serverValues };
    set({
      values: nextValues,
      items: get().items.map((it) => (it.id === id ? { ...it, enabled: nextValues[it.id] === true } : it)),
      file: String(res?.file || get().file || ''),
      error: null,
    });
  },
}));

/** 某页是否开启（读 getState 快照，不订阅；未加载一律 false） */
export const isPageEnabled = (id: string): boolean => usePageStore.getState().values[id] === true;

/** 默认落点：按 order 取第一个开启的页（排除 config —— 设置永远是「去的地方」，不是「停的地方」） */
export const firstEnabledPageId = (): string | null => {
  const { items, values } = usePageStore.getState();
  return [...items]
    .filter((it) => it.id !== 'config' && values[it.id] === true)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0]?.id ?? null;
};

/**
 * 页签归一：请求页可用就给它；不可用（已关闭 / 未知 / 历史页签）落到第一个可用页；
 * 一个可用页都没有（config 不算）则返回 null —— 调用方渲染空态页。
 */
export const resolveTab = (requested?: string | null): string | null => {
  const { items, values } = usePageStore.getState();
  if (requested) {
    const hit = items.find((it) => it.id === requested);
    if (hit && values[hit.id] === true) return hit.id;
  }
  return firstEnabledPageId();
};

/* ─────── 页签准入的共用真源已迁入注册表（设计 §9.2 / 未完成清单第 15 条） ─────── */

/**
 * 原 `GLOBAL_TABS` / `LEGACY_TAB_LABEL` 已删除：两张表的真相改为**页面条目自带**
 * （`ui-registry/entries/pages.tsx` 的 `meta.global` 与 `variant: 'retired'` 条目），
 * 消费方一律从 `ui-registry/pageTabs.ts` 读：
 *   · `globalPageIds()` / `isGlobalPage(id)` —— 无项目也能停留的全局页；
 *   · `legacyTabLabel(id)`                  —— 已下线页签的展示名。
 * 这样加页 / 下线页只改条目，不再有第二张表需要同步。
 */
