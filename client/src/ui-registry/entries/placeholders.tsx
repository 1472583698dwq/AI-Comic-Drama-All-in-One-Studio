import React from 'react';
import { Hammer, PackageOpen, Undo2 } from 'lucide-react';
import { toast } from '../../stores/useDialogStore';
import { usePageStore } from '../../stores/usePageStore';
import { useUiPrefsStore } from '../../stores/useUiPrefsStore';
import { DEFAULT_VARIANT } from '../types';
import { variantLabel } from './variants';

/**
 * 「重构新版」占位条目（本轮 Phase 1+2 专用）。
 *
 * 存在的意义有两个，都不涉及视觉重设计（设计 §9.4）：
 *   1. 让「切到新版 → 立即生效 → 切回保底」这条链路**当场可验证**，而不是等真重构那天才第一次跑；
 *   2. **自带自救按钮**：万一用户把设置页（config）切到了新版却是个坏版本，
 *      这里仍有一条路切回保底版本 —— 否则「关掉自己后无法再打开开关」的死锁又回来了（设计 §1 口径 1）。
 *
 * 页面名从 `usePageStore` 契约里取（不硬编码中文标签），后端改名这里自动跟上。
 */
export const NewVersionPlaceholder: React.FC<{ pageId: string; variant: string }> = ({ pageId, variant }) => {
  const label = usePageStore((s) => s.items.find((it) => it.id === pageId)?.label || pageId);
  const setPageVariant = useUiPrefsStore((s) => s.setPageVariant);
  const fallbackLabel = variantLabel(DEFAULT_VARIANT);

  const backToFallback = () => {
    setPageVariant(pageId, DEFAULT_VARIANT);
    toast.info(`「${label}」已切回${fallbackLabel}`);
  };

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-10 overflow-y-auto custom-scrollbar">
      <div className="w-full max-w-[540px] rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 px-6 py-7 text-center">
        <span className="mx-auto w-12 h-12 rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 flex items-center justify-center">
          <Hammer className="w-5 h-5 text-gray-400" />
        </span>

        <h2 className="mt-4 text-[15px] font-bold text-[color:var(--color-text-main)]">{label} · 新版本待接入</h2>
        <p className="mt-1.5 text-[11.5px] text-gray-400 leading-relaxed">
          这一页已经接入版本切换，但重构新版还没做。当前激活的版本标识是
          <span className="mx-1 px-1.5 py-0.5 rounded border border-white/70 dark:border-white/12 bg-surface/80 text-gray-300 font-mono text-[11px]">
            {variant}
          </span>
          ，切回{fallbackLabel}即可回到原来的界面。
        </p>
        <p className="mt-1 text-[10.5px] text-gray-500">
          页面标识：<span className="font-mono">{pageId}</span>（版本偏好只存本机 localStorage，不动后端能力与接口准入）
        </p>

        <button
          onClick={backToFallback}
          className="mt-5 h-9 px-4 inline-flex items-center gap-1.5 rounded-xl bg-brand text-white text-[12px] font-bold hover:bg-brand-light transition-colors"
        >
          <Undo2 className="w-4 h-4" />切回{fallbackLabel}
        </button>
      </div>
    </div>
  );
};

/**
 * 「后端开着这一页、本前端却没有它的实现」的兜底（审查 M5）。
 *
 * 与全关空态页（`shell.empty` / `NoPageEnabled`）**不是一回事**，所以必须显式区分：
 *   · 一个可用页都没有（`resolvedTab === null`）→ 全关空态页，文案是「当前没有开启任何功能页」；
 *   · 归一结果非空、但页面槽里没有生效条目 → 就是这里：后端/未来插件新增了一个 page id 并开启，
 *     侧栏入口与页签都进得来，而 `entries/pages.tsx` 里还没有登记它的实现。
 *     （`resolveTab()` 只按后端 `/pages` 的 id + 开关判定，不认前端的实现表 —— 见
 *     `stores/usePageStore.ts` 的 `resolveTab` / `firstEnabledPageId`。）
 * 后者若复用全关空态页，会谎报「当前没有开启任何功能页 + 列出已关闭页面」，而设置台里那一页明明是开着的。
 *
 * 页面名仍从 `usePageStore` 契约取（不硬编码），页面标识照实显示，便于定位是哪一页。
 */
export const UnregisteredPagePlaceholder: React.FC<{ pageId: string }> = ({ pageId }) => {
  const label = usePageStore((s) => s.items.find((it) => it.id === pageId)?.label || pageId);

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-10 overflow-y-auto custom-scrollbar">
      <div className="w-full max-w-[540px] rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 px-6 py-7 text-center">
        <span className="mx-auto w-12 h-12 rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 flex items-center justify-center">
          <PackageOpen className="w-5 h-5 text-gray-400" />
        </span>

        <h2 className="mt-4 text-[15px] font-bold text-[color:var(--color-text-main)]">{label} · 本前端尚未注册</h2>
        <p className="mt-1.5 text-[11.5px] text-gray-400 leading-relaxed">
          这一页在后端是开启的（侧栏入口也进得来），但当前前端没有登记它的实现。
          升级前端，或在 设置 → 功能开关 里把它关掉。
        </p>
        <p className="mt-1 text-[10.5px] text-gray-500">
          页面标识：<span className="font-mono">{pageId}</span>
        </p>
      </div>
    </div>
  );
};

export default NewVersionPlaceholder;
