/**
 * 模型广场：供应商列表 + 对话当前选中的模型。
 * 设置页和 AI 对话输入框读同一份，选中结果写在后端 llm_plaza.json。
 */
import { create } from 'zustand';
import { apiService } from '../../services/api';

export type PlazaProtocol = 'openai' | 'claude' | 'responses';

export interface PlazaModel {
  id: string;
  owned_by?: string;
  display?: string;
}

export interface PlazaSupplier {
  id: string;
  name: string;
  protocol?: PlazaProtocol;
  base_url: string;
  has_key: boolean;
  api_key_hint?: string;
  /** 高级：私有网关 / OpenCode 的自定义请求头 */
  headers?: Record<string, string>;
  models: PlazaModel[];
  fetched_at?: string;
  error?: string;
}

export interface PlazaActive {
  supplier_id: string;
  model: string;
}

export interface PlazaSupplierInput {
  name: string;
  base_url: string;
  api_key?: string;
  protocol?: PlazaProtocol;
  headers?: Record<string, string>;
}

interface PlazaState {
  suppliers: PlazaSupplier[];
  /** 全局默认模型（拆剧本 / 润色 / 对话都用它） */
  default: PlazaActive;
  /** 对话里的临时覆盖（只影响本次对话） */
  active: PlazaActive;
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  add: (body: PlazaSupplierInput) => Promise<PlazaSupplier | undefined>;
  update: (id: string, body: Partial<PlazaSupplierInput>) => Promise<PlazaSupplier | undefined>;
  remove: (id: string) => Promise<void>;
  refresh: (id: string) => Promise<PlazaSupplier | undefined>;
  setActive: (supplierId: string, model: string) => Promise<void>;
  setDefault: (supplierId: string, model: string) => Promise<void>;
}

const emptyActive = (): PlazaActive => ({ supplier_id: '', model: '' });

export const useLlmPlazaStore = create<PlazaState>((set, get) => ({
  suppliers: [],
  default: emptyActive(),
  active: emptyActive(),
  loaded: false,
  loading: false,
  error: '',

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: '' });
    try {
      const r = await apiService.getLlmPlaza();
      set({
        suppliers: r?.suppliers || [],
        default: r?.default || emptyActive(),
        active: r?.active || emptyActive(),
        loaded: true,
        loading: false,
      });
    } catch (e: any) {
      set({ loading: false, error: e?.message || '读取模型广场失败' });
    }
  },

  add: async (body) => {
    const r = await apiService.addLlmSupplier(body);
    const sup: PlazaSupplier | undefined = r?.supplier;
    set((s) => ({
      suppliers: sup
        ? [...s.suppliers.filter((x) => x.id !== sup.id), sup]
        : s.suppliers,
      active: r?.active || s.active,
    }));
    return sup;
  },

  update: async (id, body) => {
    const r = await apiService.updateLlmSupplier(id, body);
    const sup: PlazaSupplier | undefined = r?.supplier;
    if (sup) {
      set((s) => ({
        suppliers: s.suppliers.map((x) => (x.id === sup.id ? sup : x)),
        active: r?.active || s.active,
      }));
    }
    return sup;
  },

  remove: async (id) => {
    const r = await apiService.deleteLlmSupplier(id);
    set({
      suppliers: r?.suppliers || get().suppliers.filter((s) => s.id !== id),
      active: r?.active || emptyActive(),
    });
  },

  refresh: async (id) => {
    const r = await apiService.refreshLlmSupplier(id);
    const sup: PlazaSupplier | undefined = r?.supplier;
    if (!sup) return undefined;
    set((s) => ({
      suppliers: s.suppliers.map((x) => (x.id === sup.id ? sup : x)),
    }));
    return sup;
  },

  setActive: async (supplierId, model) => {
    const r = await apiService.setLlmActive(supplierId, model);
    set({ active: r?.active || { supplier_id: supplierId, model } });
  },

  setDefault: async (supplierId, model) => {
    const r = await apiService.setLlmDefault(supplierId, model);
    set({ default: r?.default || { supplier_id: supplierId, model } });
  },
}));
