import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  duration?: number;
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDanger?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
}

export interface PromptOptions {
  title?: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm?: (val: string) => void;
  onCancel?: () => void;
}

interface DialogState {
  toasts: ToastItem[];
  confirmDialog: (ConfirmOptions & { isOpen: boolean }) | null;
  promptDialog: (PromptOptions & { isOpen: boolean }) | null;

  addToast: (toast: Omit<ToastItem, 'id'>) => string;
  removeToast: (id: string) => void;
  openConfirm: (options: ConfirmOptions) => void;
  closeConfirm: () => void;
  openPrompt: (options: PromptOptions) => void;
  closePrompt: () => void;
}

export const useDialogStore = create<DialogState>((set, get) => ({
  toasts: [],
  confirmDialog: null,
  promptDialog: null,

  addToast: (item) => {
    const id = 'toast_' + Math.random().toString(36).substring(2, 9);
    const duration = item.duration ?? 3500;
    const newToast: ToastItem = { ...item, id, duration };

    set((state) => ({
      toasts: [...state.toasts.slice(-4), newToast], // Keep at most 5 visible toasts
    }));

    if (duration > 0) {
      setTimeout(() => {
        get().removeToast(id);
      }, duration);
    }

    return id;
  },

  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },

  openConfirm: (options) => {
    set({
      confirmDialog: {
        ...options,
        isOpen: true,
      },
    });
  },

  closeConfirm: () => {
    set({ confirmDialog: null });
  },

  openPrompt: (options) => {
    set({
      promptDialog: {
        ...options,
        isOpen: true,
      },
    });
  },

  closePrompt: () => {
    set({ promptDialog: null });
  },
}));

// Quick Helper API for Notifications
export const toast = {
  success: (message: string, title?: string) => {
    return useDialogStore.getState().addToast({ type: 'success', message, title });
  },
  error: (message: string, title?: string) => {
    return useDialogStore.getState().addToast({ type: 'error', message, title, duration: 4500 });
  },
  warning: (message: string, title?: string) => {
    return useDialogStore.getState().addToast({ type: 'warning', message, title });
  },
  info: (message: string, title?: string) => {
    return useDialogStore.getState().addToast({ type: 'info', message, title });
  },
};

// Async confirm promise replacement for native confirm()
export const confirmAsync = (options: Omit<ConfirmOptions, 'onConfirm' | 'onCancel'>): Promise<boolean> => {
  return new Promise((resolve) => {
    useDialogStore.getState().openConfirm({
      ...options,
      onConfirm: () => {
        useDialogStore.getState().closeConfirm();
        resolve(true);
      },
      onCancel: () => {
        useDialogStore.getState().closeConfirm();
        resolve(false);
      },
    });
  });
};

// Async prompt promise replacement for native prompt()
export const promptAsync = (options: Omit<PromptOptions, 'onConfirm' | 'onCancel'>): Promise<string | null> => {
  return new Promise((resolve) => {
    useDialogStore.getState().openPrompt({
      ...options,
      onConfirm: (val) => {
        useDialogStore.getState().closePrompt();
        resolve(val);
      },
      onCancel: () => {
        useDialogStore.getState().closePrompt();
        resolve(null);
      },
    });
  });
};

// Global interceptor: replaces ancient window.alert with modern dark toast
export const installGlobalDialogPatch = () => {
  if (typeof window === 'undefined') return;
  
  // Guard against multiple patches
  if ((window as any).__toast_patch_installed__) return;
  (window as any).__toast_patch_installed__ = true;

  const originalAlert = window.alert;

  window.alert = (msg?: any) => {
    const text = String(msg ?? '');
    if (!text.trim()) return;

    // Detect message nature to show appropriate toast style
    if (text.startsWith('✓') || text.includes('成功') || text.includes('已导入') || text.includes('已保存')) {
      toast.success(text);
    } else if (text.startsWith('✗') || text.includes('失败') || text.includes('错误') || text.includes('Error') || text.includes('error')) {
      toast.error(text);
    } else if (text.includes('请') || text.includes('注意') || text.includes('未') || text.includes('不能为空')) {
      toast.warning(text);
    } else {
      toast.info(text);
    }
  };
};
