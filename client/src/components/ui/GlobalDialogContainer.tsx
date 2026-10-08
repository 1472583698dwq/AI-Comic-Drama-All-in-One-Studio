import React, { useState, useEffect, useRef } from 'react';
import { 
  CheckCircle2, 
  AlertCircle, 
  AlertTriangle, 
  Info, 
  X, 
  Trash2, 
  HelpCircle 
} from 'lucide-react';
import { useDialogStore, ToastItem } from '../../stores/useDialogStore';

export const GlobalDialogContainer: React.FC = () => {
  const { toasts, removeToast, confirmDialog, closeConfirm, promptDialog, closePrompt } = useDialogStore();

  return (
    <>
      {/* ── 1. Floating Toasts Container ── */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2.5 pointer-events-none max-w-md w-full px-4 sm:px-0">
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
        ))}
      </div>

      {/* ── 2. Modern Confirm Dialog ── */}
      {confirmDialog?.isOpen && (
        <ConfirmModal
          title={confirmDialog.title || '确认操作'}
          message={confirmDialog.message}
          confirmText={confirmDialog.confirmText || '确定'}
          cancelText={confirmDialog.cancelText || '取消'}
          isDanger={confirmDialog.isDanger}
          onConfirm={() => {
            confirmDialog.onConfirm?.();
            closeConfirm();
          }}
          onCancel={() => {
            confirmDialog.onCancel?.();
            closeConfirm();
          }}
        />
      )}

      {/* ── 3. Modern Prompt Dialog ── */}
      {promptDialog?.isOpen && (
        <PromptModal
          title={promptDialog.title || '请输入内容'}
          message={promptDialog.message}
          defaultValue={promptDialog.defaultValue || ''}
          placeholder={promptDialog.placeholder || ''}
          confirmText={promptDialog.confirmText || '确定'}
          cancelText={promptDialog.cancelText || '取消'}
          onConfirm={(val) => {
            promptDialog.onConfirm?.(val);
            closePrompt();
          }}
          onCancel={() => {
            promptDialog.onCancel?.();
            closePrompt();
          }}
        />
      )}
    </>
  );
};

// ── Single Toast Notification Card ──
const ToastCard: React.FC<{ toast: ToastItem; onClose: () => void }> = ({ toast, onClose }) => {
  const getIcon = () => {
    switch (toast.type) {
      case 'success':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />;
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />;
      default:
        return <Info className="w-4 h-4 text-brand shrink-0 mt-0.5" />;
    }
  };

  const getBorderColor = () => {
    switch (toast.type) {
      case 'success':
        return 'border-emerald-500/30 bg-surface/80 dark:bg-[#141419]/95 backdrop-blur-2xl shadow-emerald-500/5';
      case 'error':
        return 'border-red-500/30 bg-surface/80 dark:bg-[#141419]/95 backdrop-blur-2xl shadow-red-500/5';
      case 'warning':
        return 'border-amber-500/30 bg-surface/80 dark:bg-[#141419]/95 backdrop-blur-2xl shadow-amber-500/5';
      default:
        return 'border-brand/30 bg-surface/80 dark:bg-[#141419]/95 backdrop-blur-2xl shadow-brand/5';
    }
  };

  return (
    <div
      className={`pointer-events-auto border rounded-2xl p-3 shadow-2xl backdrop-blur-xl flex items-start gap-3 transition-all transform animate-in slide-in-from-top-3 fade-in duration-200 ${getBorderColor()}`}
    >
      {getIcon()}
      <div className="flex-1 min-w-0 pr-1">
        {toast.title && (
          <div className="text-xs font-bold text-white tracking-tight mb-0.5">
            {toast.title}
          </div>
        )}
        <div className="text-xs text-gray-200 leading-relaxed break-words whitespace-pre-line">
          {toast.message}
        </div>
      </div>
      <button
        onClick={onClose}
        className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-surface/80 transition-colors shrink-0 -mr-1 -mt-1"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

// ── Modern Confirm Modal ──
interface ConfirmModalProps {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  isDanger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  title,
  message,
  confirmText,
  cancelText,
  isDanger,
  onConfirm,
  onCancel,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onConfirm, onCancel]);

  return (
    <div className="fixed inset-0 z-[99999] bg-black/65 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-md bg-surface/80 dark:bg-[#141419]/95 backdrop-blur-2xl border border-white/70 dark:border-white/12 rounded-3xl p-6 shadow-[0_30px_70px_-28px_rgba(15,23,42,.7)] flex flex-col gap-4 animate-in zoom-in-95 duration-150">
        <div className="flex items-start gap-3.5">
          <div
            className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${
              isDanger
                ? 'bg-red-500/15 border border-red-500/30 text-red-400'
                : 'bg-brand/15 border border-brand/30 text-brand'
            }`}
          >
            {isDanger ? <Trash2 className="w-5 h-5" /> : <HelpCircle className="w-5 h-5" />}
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <h3 className="text-sm font-bold text-white tracking-tight">{title}</h3>
            <p className="text-xs text-gray-300 mt-1 leading-relaxed whitespace-pre-line">{message}</p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-white/60 dark:border-white/10">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl bg-surface/80 hover:bg-surface/80 border border-white/70 dark:border-white/12 text-xs font-semibold text-gray-300 hover:text-white transition-all"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all shadow-md ${
              isDanger
                ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-500/20'
                : 'bg-gradient-to-r from-brand to-brand-blue text-white shadow-brand/20 hover:opacity-90'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Modern Prompt Modal ──
interface PromptModalProps {
  title: string;
  message?: string;
  defaultValue: string;
  placeholder?: string;
  confirmText: string;
  cancelText: string;
  onConfirm: (val: string) => void;
  onCancel: () => void;
}

const PromptModal: React.FC<PromptModalProps> = ({
  title,
  message,
  defaultValue,
  placeholder,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
}) => {
  const [val, setVal] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    onConfirm(val);
  };

  return (
    <div className="fixed inset-0 z-[99999] bg-black/65 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md bg-surface/80 border border-white/70 dark:border-white/12 rounded-3xl p-6 shadow-2xl flex flex-col gap-4 animate-in zoom-in-95 duration-150"
      >
        <div>
          <h3 className="text-sm font-bold text-white tracking-tight">{title}</h3>
          {message && <p className="text-xs text-gray-400 mt-1">{message}</p>}
        </div>

        <input
          ref={inputRef}
          type="text"
          value={val}
          placeholder={placeholder}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel();
          }}
          className="w-full px-3.5 py-2.5 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 focus:border-brand focus:outline-none text-xs text-white placeholder-gray-500 shadow-inner"
        />

        <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-white/60 dark:border-white/10">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-xl bg-surface/80 hover:bg-surface/80 border border-white/70 dark:border-white/12 text-xs font-semibold text-gray-300 hover:text-white transition-all"
          >
            {cancelText}
          </button>
          <button
            type="submit"
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white text-xs font-semibold shadow-md shadow-brand/20 hover:opacity-90 transition-all"
          >
            {confirmText}
          </button>
        </div>
      </form>
    </div>
  );
};
