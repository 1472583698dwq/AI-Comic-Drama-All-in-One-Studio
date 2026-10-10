import { create } from 'zustand';
import type { CreateKind, CreateTab } from '../components/provider/ProviderCreateModal';

/**
 * 全局弹窗「意图」store（Phase 2 必需的一次等价搬运）。
 *
 * 弹窗的**打开机制一个字都不改**（设计 §4 Phase 2）：仍然是那 8 个 `window` 自定义事件
 * 与各处既有触发点，只是事件监听器从「改 App 的局部 state」变成「写这个 store」。
 * 原因很简单：弹窗的渲染位置挪进注册表后，槽里的组件拿不到 App 的局部 state，
 * 状态载体必须换成一个两边都能读到的地方；换的事件名、触发时机、参数完全一致。
 *
 * 层叠顺序仍由 `entries/modals.tsx` 的登记顺序决定（与原先 JSX 顺序一一对应）。
 */

export interface ProviderCreateIntent {
  open: boolean;
  tab: CreateTab;
  kind: CreateKind;
  select: boolean;
  source: string;
}

const CLOSED_CREATE: ProviderCreateIntent = { open: false, tab: 'doc', kind: 'image', select: false, source: '' };

interface ModalIntentsState {
  importOpen: boolean;
  exportOpen: boolean;
  mcpOpen: boolean;
  skillsOpen: boolean;
  providerManagerOpen: boolean;
  /** 打开生成源管理弹窗时直接进入编辑态的生成源（null = 只看列表） */
  providerEdit: any | null;
  providerCreate: ProviderCreateIntent;
  workflowImportOpen: boolean;
  /** 非空 = 工作流槽位配置弹窗打开（参数即 workflow id） */
  wfInspectId: string;

  openImport: () => void;
  closeImport: () => void;
  openExport: () => void;
  closeExport: () => void;
  openMcp: () => void;
  closeMcp: () => void;
  openSkills: () => void;
  closeSkills: () => void;
  openProviderManager: (provider?: any) => void;
  closeProviderManager: () => void;
  openProviderCreate: (detail?: Partial<ProviderCreateIntent>) => void;
  closeProviderCreate: () => void;
  openWorkflowImport: () => void;
  closeWorkflowImport: () => void;
  openWorkflowInspector: (workflowId: string) => void;
  closeWorkflowInspector: () => void;
}

export const useModalIntentsStore = create<ModalIntentsState>((set) => ({
  importOpen: false,
  exportOpen: false,
  mcpOpen: false,
  skillsOpen: false,
  providerManagerOpen: false,
  providerEdit: null,
  providerCreate: CLOSED_CREATE,
  workflowImportOpen: false,
  wfInspectId: '',

  openImport: () => set({ importOpen: true }),
  closeImport: () => set({ importOpen: false }),
  openExport: () => set({ exportOpen: true }),
  closeExport: () => set({ exportOpen: false }),
  openMcp: () => set({ mcpOpen: true }),
  closeMcp: () => set({ mcpOpen: false }),
  openSkills: () => set({ skillsOpen: true }),
  closeSkills: () => set({ skillsOpen: false }),

  openProviderManager: (provider) => set({ providerManagerOpen: true, providerEdit: provider ?? null }),
  closeProviderManager: () => set({ providerManagerOpen: false, providerEdit: null }),

  openProviderCreate: (detail) => set(() => ({
    providerCreate: {
      open: true,
      tab: (detail?.tab as CreateTab) || 'doc',
      kind: (detail?.kind as CreateKind) || 'image',
      select: !!detail?.select,
      source: String(detail?.source || ''),
    },
  })),
  closeProviderCreate: () => set((s) => ({ providerCreate: { ...s.providerCreate, open: false } })),

  openWorkflowImport: () => set({ workflowImportOpen: true }),
  closeWorkflowImport: () => set({ workflowImportOpen: false }),
  openWorkflowInspector: (workflowId) => { if (workflowId) set({ wfInspectId: String(workflowId) }); },
  closeWorkflowInspector: () => set({ wfInspectId: '' }),
}));

/** 非 hook 读取（事件监听器等非渲染场景用） */
export const modalIntents = () => useModalIntentsStore.getState();
