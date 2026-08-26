import { create } from 'zustand';
import { Asset, AssetCategory } from '../types';
import { apiService } from '../services/api';

interface AssetState {
  assets: Asset[];
  total: number;
  page: number;
  limit: number;
  category: AssetCategory | 'all';
  q: string;
  tag: string;
  sort: string;
  scope: string; // project | global | all —— P0
  isLoading: boolean;
  error: string | null;
  selectedId: string | null;

  fetchAssets: (opts?: { category?: string; q?: string; tag?: string; page?: number; sort?: string; scope?: string; project_id?: string }) => Promise<void>;
  setCategory: (c: AssetCategory | 'all') => void;
  setQuery: (q: string) => void;
  setTag: (t: string) => void;
  selectAsset: (id: string | null) => void;
  createAsset: (form: FormData) => Promise<Asset>;
  updateAsset: (id: string, form: FormData) => Promise<Asset>;
  batchImport: (files: File[], meta?: { category?: string; tags?: string; visual_prompt?: string }) => Promise<{ imported: number; errors: string[] }>;
  generateAsset: (params: {
    name: string; prompt: string; category?: string; style_preset?: string;
    provider?: string; workflow_id?: string; negative_prompt?: string; aspect_ratio?: string;
    seed?: number; tags?: string; dynamic_inputs?: Record<string, any>;
  }) => Promise<{ asset: Asset; generation: any }>;
  deleteAsset: (id: string) => Promise<void>;
  duplicateAsset: (id: string) => Promise<void>;
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
  scope: 'all',
  isLoading: false,
  error: null,
  selectedId: null,

  fetchAssets: async (opts) => {
    const cat = opts?.category ?? get().category;
    const q = opts?.q ?? get().q;
    const tag = opts?.tag ?? get().tag;
    const sort = opts?.sort ?? get().sort;
    const scope = opts?.scope ?? (get() as any).scope ?? 'all';
    const page = opts?.page ?? 1;
    // P0: 自动带当前项目
    let project_id = (opts as any)?.project_id;
    if (project_id === undefined) {
      try { project_id = (await import('./useProjectListStore')).useProjectListStore.getState().activeProjectId || (await import('./useProjectStore')).useProjectStore.getState().activeProjectId || undefined; } catch {}
    }
    set({ isLoading: true, error: null });
    try {
      const data = await apiService.listAssets({ category: cat, q, tag, page, limit: get().limit, sort, scope: scope==='all'?undefined:scope, project_id, include_shared: true });
      set({ assets: data.assets, total: data.total, page: data.page, category: cat as any, q, tag, sort, scope, isLoading: false });
    } catch (e: any) {
      set({ error: e?.message || '加载失败', isLoading: false });
    }
  },

  setCategory: (c) => {
    set({ category: c });
    get().fetchAssets({ category: c, page: 1 });
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
    const res = await apiService.batchImportAssets(files, meta);
    get().fetchAssets({ page: 1 });
    return { imported: res.imported, errors: res.errors || [] };
  },

  generateAsset: async (params) => {
    const res = await apiService.generateAsset(params);
    get().fetchAssets({ page: 1 });
    return res;
  },

  deleteAsset: async (id) => {
    await apiService.deleteAsset(id);
    set({ assets: get().assets.filter(a => a.id !== id), total: get().total - 1 });
  },

  duplicateAsset: async (id) => {
    await apiService.duplicateAsset(id);
    get().fetchAssets({ page: 1 });
  },
}));
