/**
 * 模型广场：供应商列表 + 对话当前选中的模型。
 * 设置页和 AI 对话输入框读同一份，选中结果写在后端 llm_plaza.json。
 */
import { create } from 'zustand';
import { apiService } from '../../services/api';

export type PlazaProtocol = 'openai' | 'claude';

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
  models: PlazaModel[];
  fetched_at?: string;
  error?: string;
}

export interface PlazaActive {
  supplier_id: string;
  model: string;
}

interface PlazaState {
  suppliers: PlazaSupplier[];
  active: PlazaActive;
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  add: (body: { name: string; base_url: string; api_key?: string; protocol?: PlazaProtocol }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: (id: string) => Promise<void>;
  setActive: (supplierId: string, model: string) => Promise<void>;
}

const emptyActive = (): PlazaActive => ({ supplier_id: '', model: '' });

export const useLlmPlazaStore = create<PlazaState>((set, get) => ({
  suppliers: [],
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
    const sup = r?.supplier;
    set((s) => ({
      suppliers: sup
        ? [...s.suppliers.filter((x) => x.id !== sup.id), sup]
        : s.suppliers,
      active: r?.active || s.active,
    }));
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
    const sup = r?.supplier;
    if (!sup) return;
    set((s) => ({
      suppliers: s.suppliers.map((x) => (x.id === sup.id ? sup : x)),
    }));
  },

  setActive: async (supplierId, model) => {
    const r = await apiService.setLlmActive(supplierId, model);
    set({ active: r?.active || { supplier_id: supplierId, model } });
  },
}));
