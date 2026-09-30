import React, { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Lock, ArrowRight, Power, Layers } from 'lucide-react';
import { usePageStore, resolveTab } from '../../stores/usePageStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { toast } from '../../stores/useDialogStore';
import { pageIcon } from '../../utils/pageIcons';

/** 无项目时也能进的全局页（其余页面需要先有项目才能前往） */
const GLOBAL_TABS = ['home', 'projects', 'config'];

/**
 * 功能开关（设置 → 功能开关）：页面级运行时开关。
 *
 * 数据源与准入唯一口径都是后端 `/api/v1/pages`（前端不缓存、不猜默认值）：
 * 打开即生效 —— 侧栏出现入口、页签可直达、后端对应能力族接口恢复；
 * 关闭即关干净 —— 入口隐藏、页签归一回落、接口返回 404（不残留半开启状态）。
 * 设置（config）是 locked 系统页，只展示不可切。
 */
export const FeaturesPanel: React.FC = () => {
  const items = usePageStore((s) => s.items);
  const values = usePageStore((s) => s.values);
  const file = usePageStore((s) => s.file);
  const loading = usePageStore((s) => s.loading);
  const error = usePageStore((s) => s.error);
  const load = usePageStore((s) => s.load);
  const setPage = usePageStore((s) => s.setPage);
  const activeTab = useProjectStore((s) => s.activeTab);
  const project = useProjectStore((s) => s.project);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { load(); }, [load]);

  const toggle = async (id: string, label: string, next: boolean) => {
    setBusy(id);
    try {
      await setPage(id, next);
      if (next) {
        toast.success(`已开启「${label}」，左侧栏入口已出现`);
      } else {
        toast.info(`已关闭「${label}」，入口已隐藏且对应接口返回 404`);
        // 关掉的正好是当前所在页 → 立刻按可用性回落（App 侧还有一层归一兜底）
        if (activeTab === id) {
          const nextTab = resolveTab(activeTab);
          if (nextTab) useProjectStore.getState().setActiveTab(nextTab as any);
        }
      }
    } catch (e: any) {
      toast.error(e?.message || '切换失败');
    } finally {
      setBusy(null);
    }
  };

  const go = (id: string) => {
    if (!GLOBAL_TABS.includes(id) && !project) {
      toast.info('请先在项目看板创建或打开项目');
      return;
    }
    useProjectStore.getState().setActiveTab(id as any);
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-[13.5px] font-bold text-[color:var(--color-text-main)]">功能开关</h3>
        <p className="mt-1 text-[11.5px] text-gray-400 leading-relaxed">
          页面级开关：打开后左侧栏出现入口、页签可直达，后端对应能力族接口同时恢复；
          关闭后入口隐藏、页签自动回落，接口返回 404 —— 关得干净，不会留下半开启状态。
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-[11.5px] text-amber-300 flex items-center justify-between gap-3">
          <span>读取页面开关失败：{error}（当前按内置默认集显示，可能与你上次保存的状态不一致）</span>
          <button onClick={() => load()} className="shrink-0 px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 flex items-center gap-1">
            <RefreshCw className="w-3 h-3" />重试
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        {items.length === 0 && (
          <div className="rounded-xl border border-border bg-surface-secondary px-3.5 py-3 text-[11.5px] text-gray-500 flex items-center gap-2">
            {loading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />读取中…</> : '没有可切换的页面'}
          </div>
        )}

        {items.map((it) => {
          const Icon = pageIcon(it.id, it.icon);
          const enabled = values[it.id] === true;
          const working = busy === it.id;
          const locked = it.locked === true;
          return (
            <div key={it.id}
              className="rounded-xl border border-border bg-surface-secondary px-3.5 py-3 flex items-start gap-3">
              <div className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center ${enabled ? 'bg-brand/15 text-brand-light' : 'bg-surface-tertiary text-gray-500'}`}>
                <Icon className="w-4 h-4" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12.5px] font-bold text-[color:var(--color-text-main)]">{it.label}</span>
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] ${
                    enabled ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
                            : 'text-gray-400 border-border bg-surface-tertiary'
                  }`}>{enabled ? '已开启' : '已关闭'}</span>
                  {locked && (
                    <span className="px-1.5 py-0.5 rounded border border-border bg-surface-tertiary text-[10px] text-gray-400 inline-flex items-center gap-1">
                      <Lock className="w-2.5 h-2.5" />系统页，不可关闭
                    </span>
                  )}
                  {it.default && !locked && (
                    <span className="text-[10px] text-gray-500">出厂默认{enabled ? '开启' : '关闭'}</span>
                  )}
                </div>

                <p className="mt-1 text-[11px] text-gray-400 leading-relaxed">
                  {it.description || `页面：${it.id}${it.host && it.host !== it.id ? `（host: ${it.host}）` : ''}`}
                </p>

                {enabled ? (
                  <button
                    onClick={() => go(it.id)}
                    className="mt-2 px-2.5 py-1 rounded-lg text-[11px] bg-brand text-white hover:bg-brand-light inline-flex items-center gap-1"
                  >
                    前往{it.label}<ArrowRight className="w-3 h-3" />
                  </button>
                ) : (
                  <span
                    title="开启后才能进入该页"
                    className="mt-2 px-2.5 py-1 rounded-lg text-[11px] border border-border bg-surface text-gray-500 inline-flex items-center gap-1 cursor-not-allowed"
                  >
                    <Lock className="w-3 h-3" />开启后可前往
                  </span>
                )}
              </div>

              {locked ? (
                <span
                  title="系统页，不可关闭"
                  className="shrink-0 mt-0.5 w-11 h-6 rounded-full relative bg-brand/40 border border-border flex items-center justify-center"
                >
                  <Lock className="w-3 h-3 text-white/80" />
                </span>
              ) : (
                <button
                  onClick={() => toggle(it.id, it.label, !enabled)}
                  disabled={working}
                  role="switch"
                  aria-checked={enabled}
                  className={`shrink-0 mt-0.5 w-11 h-6 rounded-full relative transition-colors disabled:opacity-60 ${
                    enabled ? 'bg-brand' : 'bg-surface-tertiary border border-border'
                  }`}
                  title={enabled ? '点击关闭' : '点击开启'}
                >
                  <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
                  {working && <Loader2 className="absolute inset-0 m-auto w-3 h-3 animate-spin text-white/80" />}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* 非页面级开关：位置先留好，能力就绪后再挂真实开关（这里不放假开关） */}
      <div className="rounded-xl border border-dashed border-border bg-surface/60 px-3.5 py-3">
        <div className="flex items-center gap-2 text-[11.5px] font-bold text-[color:var(--color-text-main)]">
          <Power className="w-3.5 h-3.5 text-gray-500" />能力级开关（后续接入）
        </div>
        <p className="mt-1 text-[10.5px] text-gray-500 leading-relaxed">
          非页面级能力开关（多模态附件 / 子代理集群 / 导演台多机位等）将在后续阶段接入本面板；
          当前阶段只提供上面的页面级开关。
        </p>
        <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-gray-600">
          <Layers className="w-3 h-3" />占位：具体开关随对应能力落地后逐个补齐
        </div>
      </div>

      {file && (
        <p className="text-[10.5px] text-gray-500">开关存储：{file}（改完即时生效，无需重启）</p>
      )}
    </div>
  );
};

export default FeaturesPanel;
