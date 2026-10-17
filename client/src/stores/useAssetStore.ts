import { create } from 'zustand';
import { Asset, AssetCategory } from '../types';
import { apiService } from '../services/api';
import { resolveAssetOwnership } from '../utils/assetScope';

async function currentProjectId(): Promise<string | undefined> {
  try {
    const pid = (await import('./useProjectListStore')).useProjectListStore.getState().activeProjectId
      || (await import('./useProjectStore')).useProjectStore.getState().activeProjectId;
    return pid || undefined;
  } catch {
    return undefined;
  }
}

interface AssetState {
  assets: Asset[];
  total: number;
  page: number;
  limit: number;
  category: AssetCategory | 'all';
  q: string;
  tag: string;
  sort: string;
  scope: string; // project | global | shared | all
  group: string; // 分组过滤：分组路径 | __none__ | all
  isLoading: boolean;
  error: string | null;
  selectedId: string | null;

  fetchAssets: (opts?: { category?: string; q?: string; tag?: string; page?: number; sort?: string; scope?: string; project_id?: string; group?: string }) => Promise<void>;
  setCategory: (c: AssetCategory | 'all') => void;
  setGroup: (g: string) => void;
  setQuery: (q: string) => void;
  setTag: (t: string) => void;
  selectAsset: (id: string | null) => void;
  createAsset: (form: FormData) => Promise<Asset>;
  updateAsset: (id: string, form: FormData) => Promise<Asset>;
  batchImport: (files: File[], meta?: { category?: string; tags?: string; visual_prompt?: string; project_id?: string; scope?: string }) => Promise<{ imported: number; errors: string[] }>;
  generateAsset: (params: {
    name: string; prompt: string; category?: string; style_preset?: string;
    provider?: string; workflow_id?: string; negative_prompt?: string; aspect_ratio?: string;
    seed?: number; tags?: string; dynamic_inputs?: Record<string, any>;
    params?: Record<string, any>;
    project_id?: string; scope?: string;
  }) => Promise<{ asset: Asset; generation: any }>;
  deleteAsset: (id: string, opts?: { force?: boolean }) => Promise<void>;
  duplicateAsset: (id: string) => Promise<void>;
  publishAsset: (id: string) => Promise<any>;
  unpublishAsset: (id: string, force?: boolean) => Promise<any>;
  shareAsset: (id: string, targetProjectIds: string[]) => Promise<any>;
  batchShare: (ids: string[], scope: 'global' | 'project', targetProjectIds?: string[]) => Promise<{ shared: number; failed: number; errors: any[] }>;
  copyAssetToProject: (id: string, targetProjectId: string) => Promise<any>;
}

export const useAssetStore = create<AssetState>((set, get) => ({
  assets: [],
  total: 0,
  page: 1,
  limit: 24,
  category: 'all',
  q: '',
  tag: '',
  sort: 'updated_at',
  scope: 'project',
  group: 'all',
  isLoading: false,
  error: null,
  selectedId: null,

  fetchAssets: async (opts) => {
    const cat = opts?.category ?? get().category;
    const q = opts?.q ?? get().q;
    const tag = opts?.tag ?? get().tag;
    const sort = opts?.sort ?? get().sort;
    const scope = opts?.scope ?? (get() as any).scope ?? 'all';
    const group = opts?.group ?? (get() as any).group ?? 'all';
    const page = opts?.page ?? 1;
    // P0: 自动带当前项目
    let project_id = (opts as any)?.project_id;
    if (project_id === undefined) {
      project_id = await currentProjectId();
    }
    set({ isLoading: true, error: null });
    try {
      // 'all' 只是 UI 上的「全部」，不是后端类目；必须归一成 undefined，否则后端按字面比对会过滤掉全部素材
      const data = await apiService.listAssets({ category: cat==='all'?undefined:cat, q, tag, page, limit: get().limit, sort, scope: scope==='all'?undefined:scope, project_id, include_shared: scope !== 'project', group: group==='all'?undefined:group });
      set({ assets: data.assets, total: data.total, page: data.page, category: cat as any, q, tag, sort, scope, group, isLoading: false });
    } catch (e: any) {
      set({ error: e?.message || '加载失败', isLoading: false });
    }
  },

  setCategory: (c) => {
    set({ category: c });
    get().fetchAssets({ category: c, page: 1 });
  },
  setGroup: (g) => {
    set({ group: g });
    get().fetchAssets({ group: g, page: 1 });
  },
  setQuery: (q) => set({ q }),
  setTag: (t) => set({ tag: t }),
  selectAsset: (id) => set({ selectedId: id }),

  createAsset: async (form) => {
    const asset = await apiService.createAsset(form);
    get().fetchAssets({ page: 1 });
    return asset;
  },

  updateAsset: async (id, form) => {
    const asset = await apiService.updateAsset(id, form);
    // 就地更新列表，避免整页重载
    set({ assets: get().assets.map(a => a.id === id ? { ...a, ...asset } : a) });
    return asset;
  },

  batchImport: async (files, meta) => {
    // 归属统一：显式传入优先，否则默认落当前项目（无项目则全局）
    const pid = meta?.project_id ?? (await currentProjectId());
    const own = resolveAssetOwnership(meta?.scope as any, pid ?? null);
    const res = await apiService.batchImportAssets(files, { ...meta, project_id: own.project_id || undefined, scope: own.scope });
    get().fetchAssets({ page: 1 });
    return { imported: res.imported, errors: res.errors || [] };
  },

  generateAsset: async (params) => {
    // 归属统一：未显式指定时默认落当前项目
    const pid = params.project_id ?? (await currentProjectId());
    const own = resolveAssetOwnership(params.scope as any, pid ?? null);
    const res = await apiService.generateAsset({ ...params, project_id: own.project_id || undefined, scope: own.scope });
    get().fetchAssets({ page: 1 });
    return res;
  },

  deleteAsset: async (id, opts) => {
    const pid = await currentProjectId();
    await apiService.deleteAsset(id, { project_id: pid, force: opts?.force });
    set({ assets: get().assets.filter(a => a.id !== id), total: get().total - 1 });
  },

  duplicateAsset: async (id) => {
    await apiService.duplicateAsset(id);
    get().fetchAssets({ page: 1 });
  },

  publishAsset: async (id) => {
    const pid = await currentProjectId();
    const res = await apiService.publishAsset(id, pid);
    set({ assets: get().assets.map(a => a.id === id ? { ...a, ...res } : a) });
    return res;
  },

  unpublishAsset: async (id, force) => {
    const pid = await currentProjectId();
    const res = await apiService.unpublishAsset(id, pid, force);
    set({ assets: get().assets.map(a => a.id === id ? { ...a, ...res } : a) });
    return res;
  },

  shareAsset: async (id, targetProjectIds) => {
    const pid = await currentProjectId();
    const res = await apiService.shareAsset(id, { target_project_ids: targetProjectIds, project_id: pid });
    set({ assets: get().assets.map(a => a.id === id ? { ...a, ...res } : a) });
    return res;
  },

  batchShare: async (ids, scope, targetProjectIds) => {
    const pid = await currentProjectId();
    const res = await apiService.batchShareAssets({ asset_ids: ids, scope, target_project_ids: targetProjectIds, project_id: pid });
    get().fetchAssets({ page: 1 });
    return res;
  },

  copyAssetToProject: async (id, targetProjectId) => {
    const res = await apiService.copyAssetToProject(id, targetProjectId);
    return res;
  },
}));
