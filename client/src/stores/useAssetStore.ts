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
  isLoading: boolean;
  error: string | null;
  selectedId: string | null;

  fetchAssets: (opts?: { category?: string; q?: string; tag?: string; page?: number }) => Promise<void>;
  setCategory: (c: AssetCategory | 'all') => void;
  setQuery: (q: string) => void;
  setTag: (t: string) => void;
  selectAsset: (id: string | null) => void;
  createAsset: (form: FormData) => Promise<Asset>;
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
  isLoading: false,
  error: null,
  selectedId: null,

  fetchAssets: async (opts) => {
    const cat = opts?.category ?? get().category;
    const q = opts?.q ?? get().q;
    const tag = opts?.tag ?? get().tag;
    const page = opts?.page ?? 1;
    set({ isLoading: true, error: null });
    try {
      const res = await fetch(`/api/v1/assets?${new URLSearchParams({
        ...(cat !== 'all' ? { category: cat } : {}),
        ...(q ? { q } : {}),
        ...(tag ? { tag } : {}),
        page: String(page),
        limit: String(get().limit),
      })}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      set({ assets: data.assets, total: data.total, page: data.page, category: cat as any, q, tag, isLoading: false });
    } catch (e: any) {
      set({ error: e?.message || '加载失败', isLoading: false });
    }
  },

  setCategory: (c) => {
    set({ category: c });
    get().fetchAssets({ category: c, page: 1 });
  },
  setQuery: (q) => {
    set({ q });
  },
  setTag: (t) => set({ tag: t }),
  selectAsset: (id) => set({ selectedId: id }),

  createAsset: async (form) => {
    const res = await fetch('/api/v1/assets', { method: 'POST', body: form });
    if (!res.ok) throw new Error(await res.text());
    const asset = await res.json();
    // refresh
    get().fetchAssets({ page: 1 });
    return asset;
  },

  deleteAsset: async (id) => {
    const res = await fetch(`/api/v1/assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    set({ assets: get().assets.filter(a => a.id !== id), total: get().total - 1 });
  },

  duplicateAsset: async (id) => {
    const res = await fetch(`/api/v1/assets/${encodeURIComponent(id)}/duplicate`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    get().fetchAssets({ page: 1 });
  },
}));
