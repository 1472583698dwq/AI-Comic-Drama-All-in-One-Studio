/**
 * 新建项目弹窗（带风格模板）—— 原 HomeView 风格模板能力的迁移载体。
 * 「新建任务」（无项目时）与对话页项目 chip 的「新建项目」共用：
 * 名称输入 + 四个风格模板（也可选空白）→ createBlank → onCreated 回调（调用方负责切换/进对话）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useProjectListStore, type ProjectMeta } from '../../stores/useProjectListStore';
import { toast } from '../../stores/useDialogStore';

export interface StyleTemplate {
  id: string;
  label: string;
  desc: string;
  icon: string;
}

/** 原首页风格模板（git 历史 HomeView 迁移）：id 即 style_preset */
export const STYLE_TEMPLATES: StyleTemplate[] = [
  { id: 'donghua_xianxia', label: '仙侠 3D', desc: '东方玄幻 · 大场面', icon: '⚔️' },
  { id: 'japanese_anime', label: '日漫热血', desc: 'ufotable 质感 · 高饱和', icon: '🔥' },
  { id: 'cyberpunk_3d', label: '赛博朋克', desc: '霓虹夜景 · 未来都市', icon: '🌆' },
  { id: 'korean_manhwa', label: '韩漫条漫', desc: '精致线稿 · 时尚质感', icon: '💅' },
];

export interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
  /** 创建成功后回调（拿到新项目 meta；切换项目/进对话由调用方决定） */
  onCreated: (meta: ProjectMeta) => void;
  /** 首次使用引导文案（可选）：冷启动时解释这一步在做什么 */
  hint?: string;
}

export const NewProjectModal: React.FC<NewProjectModalProps> = ({ open, onClose, onCreated, hint }) => {
  const [title, setTitle] = useState('');
  const [preset, setPreset] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setPreset('');
      setCreating(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (creating) return;
    const name = title.trim() || '未命名项目';
    setCreating(true);
    try {
      const meta = await useProjectListStore.getState().createBlank({
        title: name,
        ...(preset ? { style_preset: preset } : {}),
      });
      toast.success(`已创建「${meta.title}」`);
      onCreated(meta);
    } catch (e: any) {
      toast.error(e?.message || '创建项目失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6 bg-black/45" onMouseDown={onClose}>
      <div
        className="w-[460px] max-w-full bg-surface border border-border rounded-2xl p-5 animate-fade-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-bold [color:var(--color-text-main)]">新建项目</div>
            <div className="mt-0.5 text-[11px] [color:var(--color-text-main)] opacity-60 leading-4">
              {hint || '选一个风格模板，项目里的生图会默认按这个风格走。'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="p-1.5 rounded-lg hover:bg-surface-hover [color:var(--color-text-main)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4">
          <div className="text-[11px] font-semibold [color:var(--color-text-main)] mb-1.5">项目名称</div>
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            placeholder="未命名项目"
            className="w-full h-9 rounded-lg bg-surface-hover px-3 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-main)] opacity-90 focus:outline-none focus:ring-1 focus:ring-brand/50"
          />
        </div>

        <div className="mt-4">
          <div className="text-[11px] font-semibold [color:var(--color-text-main)] mb-1.5">风格模板</div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setPreset('')}
              className={`relative flex items-center gap-2 p-2.5 rounded-xl border text-left transition-colors ${
                preset === '' ? 'border-brand bg-brand/10' : 'border-border hover:border-brand/50'
              }`}
            >
              <span className="w-8 h-8 rounded-lg bg-surface-tertiary flex items-center justify-center text-sm shrink-0">🎬</span>
              <span className="min-w-0">
                <span className="block text-[11px] font-bold [color:var(--color-text-main)]">空白项目</span>
                <span className="block text-[10px] [color:var(--color-text-main)] opacity-60">之后在设置里配</span>
              </span>
              {preset === '' && <Check className="w-3.5 h-3.5 text-brand absolute top-2 right-2" />}
            </button>
            {STYLE_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setPreset(t.id)}
                className={`relative flex items-center gap-2 p-2.5 rounded-xl border text-left transition-colors ${
                  preset === t.id ? 'border-brand bg-brand/10' : 'border-border hover:border-brand/50'
                }`}
              >
                <span className="w-8 h-8 rounded-lg bg-surface-tertiary flex items-center justify-center text-sm shrink-0">{t.icon}</span>
                <span className="min-w-0">
                  <span className="block text-[11px] font-bold [color:var(--color-text-main)]">{t.label}</span>
                  <span className="block text-[10px] [color:var(--color-text-main)] opacity-60 truncate">{t.desc}</span>
                </span>
                {preset === t.id && <Check className="w-3.5 h-3.5 text-brand absolute top-2 right-2" />}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-border text-xs [color:var(--color-text-main)] hover:bg-surface-hover transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={creating}
            className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-brand to-brand-blue text-white text-xs font-bold shadow-md shadow-brand/25 hover:opacity-95 active:scale-[0.98] transition-all disabled:opacity-50"
          >
            {creating ? '创建中…' : '创建项目'}
          </button>
        </div>
      </div>
    </div>
  );
};
