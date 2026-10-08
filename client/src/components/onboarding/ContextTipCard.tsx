import React, { useState } from 'react';
import { Lightbulb, X } from 'lucide-react';
import { isTipSeen, markTipSeen } from '../../utils/guideFlags';

interface Props {
  storageKey: string;
  title: string;
  desc: string;
}

/**
 * 上下文轻引导卡：首次进入某页面时在角落出现一张可关闭的提示，读过即不再出现。
 * 同类产品共识：micro-guide 每页 ≤1 张、由「进入该页」行为触发、不阻塞操作、不用连点 tour。
 */
export const ContextTipCard: React.FC<Props> = ({ storageKey, title, desc }) => {
  const [show, setShow] = useState(() => !isTipSeen(storageKey));
  if (!show) return null;

  const close = () => {
    markTipSeen(storageKey);
    setShow(false);
  };

  return (
    <div className="absolute top-16 right-3 z-30 w-[290px] rounded-2xl bg-surface/80 dark:bg-[#101014]/90 backdrop-blur border border-brand/30 shadow-2xl shadow-brand/10 overflow-hidden">
      <div className="px-3.5 py-2.5 flex items-start gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-brand/15 border border-brand/30 flex items-center justify-center shrink-0 mt-0.5">
          <Lightbulb className="w-3.5 h-3.5 text-brand-light" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-white">{title}</div>
          <div className="text-[11px] text-gray-400 leading-relaxed mt-0.5">{desc}</div>
        </div>
        <button onClick={close} title="知道了" className="p-1 rounded hover:bg-white/10 shrink-0">
          <X className="w-3.5 h-3.5 text-gray-400" />
        </button>
      </div>
      <button onClick={close} className="w-full py-1.5 bg-brand/10 hover:bg-brand/20 text-[11px] font-bold text-brand-light border-t border-brand/20">
        知道了
      </button>
    </div>
  );
};
