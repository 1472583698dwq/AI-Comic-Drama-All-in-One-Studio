import React from 'react';
import { PowerOff, Settings, ArrowRight } from 'lucide-react';
import { usePageStore } from '../../stores/usePageStore';
import { useProjectStore } from '../../stores/useProjectStore';

/**
 * 空态页：所有功能页都被关闭（一个可用页都没有）时的唯一落点。
 * 不做「偷偷替用户打开某一页」这类隐式操作 —— 只说明现状 + 给一条去设置的路。
 */
export const NoPageEnabled: React.FC = () => {
  const items = usePageStore((s) => s.items);
  const values = usePageStore((s) => s.values);
  const error = usePageStore((s) => s.error);
  const setActiveTab = useProjectStore((s) => s.setActiveTab);

  // config（设置）不算可用页，但它是唯一的「自救入口」，不作为「被关闭的页面」展示
  const disabled = items.filter((it) => it.id !== 'config' && values[it.id] !== true);

  const goSetup = () => {
    // 设置页启动时读这个 key 决定落在哪个一级页签
    try { localStorage.setItem('config_pending_tab', 'features'); } catch { /* ignore */ }
    setActiveTab('config');
  };

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-10 overflow-y-auto custom-scrollbar">
      <div className="w-full max-w-[540px] rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 px-6 py-7 text-center">
        <span className="mx-auto w-12 h-12 rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 flex items-center justify-center">
          <PowerOff className="w-5 h-5 text-gray-400" />
        </span>

        <h2 className="mt-4 text-[15px] font-bold text-[color:var(--color-text-main)]">当前没有开启任何功能页</h2>
        <p className="mt-1.5 text-[11.5px] text-gray-400 leading-relaxed">
          所有功能页都处于关闭状态，界面暂时无页可进。到「设置 → 功能开关」打开需要的页面即可继续。
        </p>

        {error && (
          <p className="mt-2 text-[11px] text-amber-300">读取功能页开关失败：{error}</p>
        )}

        {disabled.length > 0 && (
          <div className="mt-4 rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 px-3.5 py-3 text-left">
            <div className="text-[10.5px] font-bold uppercase tracking-wider text-gray-500">已关闭的页面</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {disabled.map((it) => (
                <span key={it.id} className="px-2 py-0.5 rounded-lg border border-white/70 dark:border-white/12 bg-surface/80 text-[11px] text-gray-400">
                  {it.label}
                </span>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={goSetup}
          className="mt-5 h-9 px-4 inline-flex items-center gap-1.5 rounded-xl bg-brand text-white text-[12px] font-bold hover:bg-brand-light transition-colors"
        >
          <Settings className="w-4 h-4" />去设置 → 功能开关
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

export default NoPageEnabled;
