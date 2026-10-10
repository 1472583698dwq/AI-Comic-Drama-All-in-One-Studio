import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bug, ListTree, Lock, Power, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { GLASS } from '../../components/ui/designKit';
import { confirmAsync, toast } from '../../stores/useDialogStore';
import { refreshExtensionState } from '../../services/extensionsStream';
import { usePageStore } from '../../stores/usePageStore';
import { useUiPrefsStore } from '../../stores/useUiPrefsStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { register } from '../registry';
import { explainEntry, useRegistryDiagnostics, type EntryState } from '../resolveEnabled';
import { useT, type UiTextKey } from '../i18n';
import { SETTINGS_PANELS_HOST, type UIEntry } from '../types';

/**
 * 设置台内的两个**可插拔面板**（原型 v3 右列那两个）：
 *   · 注册表视图 —— 把注册表本身摊开给人看（条目 kind / host / scope / variant / source / 状态 + 锁定壳清单）
 *   · 诊断与演练 —— 只读诊断、「恢复保底版本」、「外部停用当前页」演练、开发模式故障注入
 *
 * 为什么走 `prefs` 层而不是 `feature` 层：原型的这两个面板挂在 feature 上，但本仓
 * `features.json` 只有 agent_* 三项，而设计 §1 明令**不新增后端契约** —— 于是改用
 * 「本机 UI 偏好」这一层（开关项见 `useUiPrefsStore` 的 `settings_registry_view` /
 * `settings_diagnostics`），语义也正好合适：它们只影响这台设备上「看见什么」。
 */

const STATE_CLS: Record<EntryState, string> = {
  on: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  locked: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  'off-page': 'text-gray-400 border-white/70 dark:border-white/12 bg-surface-hover/80',
  'off-feature': 'text-gray-400 border-white/70 dark:border-white/12 bg-surface-hover/80',
  'off-prefs': 'text-gray-400 border-white/70 dark:border-white/12 bg-surface-hover/80',
  variant: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
  loading: 'text-gray-500 border-white/70 dark:border-white/12 bg-surface-hover/80',
};

const STATE_KEY: Record<EntryState, UiTextKey> = {
  on: 'state.on',
  locked: 'state.locked',
  'off-page': 'state.offPage',
  'off-feature': 'state.offFeature',
  'off-prefs': 'state.offPrefs',
  variant: 'state.variant',
  loading: 'state.loading',
};

const SourceTag: React.FC<{ entry: UIEntry }> = ({ entry }) => {
  const src = entry.source || 'builtin';
  const isPlugin = src.startsWith('plugin:');
  return (
    <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded border ${
      isPlugin ? 'text-orange-300 border-orange-500/50 bg-orange-500/10'
               : 'text-gray-400 border-white/70 dark:border-white/12 bg-surface-hover/80'
    }`}>{src}</span>
  );
};

/* ─────────────────────────── ① 注册表视图 ─────────────────────────── */

export const RegistryViewEntry: React.FC = () => {
  const t = useT();
  const { entries, snap } = useRegistryDiagnostics();

  const stats = useMemo(() => ({
    total: entries.length,
    locked: entries.filter((e) => e.locked).length,
    // 计的是 `plugin:*` 来源：契约里「非内置」只有这一种写法（`UISource`），
    // 但它涵盖所有外部贡献（含 standalone 槽）—— 所以对外标签是「外部来源」，不谎称都是插件（审查 L4-3）
    plugins: entries.filter((e) => (e.source || '').startsWith('plugin:')).length,
  }), [entries]);

  const locked = useMemo(() => entries.filter((e) => e.locked), [entries]);

  return (
    <section className={`${GLASS} rounded-2xl px-5 py-4`}>
      <div className="flex items-center gap-2 flex-wrap">
        <ListTree className="w-4 h-4 text-gray-500" />
        <h3 className="text-[13px] font-bold text-[color:var(--color-text-main)]">{t('panel.registry.label')}</h3>
        <span className="font-mono text-[9.5px] tracking-[.16em] uppercase text-gray-500">REGISTRY</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] text-gray-500">{t('registry.stat.total')} {stats.total}</span>
          <span className="font-mono text-[10px] text-amber-300">{t('registry.stat.locked')} {stats.locked}</span>
          <span className="font-mono text-[10px] text-gray-500">{t('registry.stat.plugins')} {stats.plugins}</span>
        </div>
      </div>

      <div className="mt-3 max-h-[380px] overflow-auto custom-scrollbar rounded-xl border border-white/70 dark:border-white/12">
        <table className="w-full text-[11px] border-collapse">
          <thead className="sticky top-0 bg-surface/95 backdrop-blur">
            <tr className="text-left font-mono text-[9.5px] uppercase tracking-[.1em] text-gray-500">
              <th className="px-2.5 py-2 font-semibold">{t('registry.col.entry')}</th>
              <th className="px-2 py-2 font-semibold">{t('registry.col.kind')}</th>
              <th className="px-2 py-2 font-semibold">{t('registry.col.host')}</th>
              <th className="px-2 py-2 font-semibold">{t('registry.col.scope')}</th>
              <th className="px-2 py-2 font-semibold">{t('registry.col.variant')}</th>
              <th className="px-2 py-2 font-semibold">{t('registry.col.source')}</th>
              <th className="px-2.5 py-2 font-semibold">{t('registry.col.state')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const state = explainEntry(e, snap);
              return (
                <tr key={e.id} className="border-t border-white/60 dark:border-white/10">
                  <td className="px-2.5 py-1.5 font-mono text-[10.5px] text-[color:var(--color-text-main)] break-all">{e.id}</td>
                  <td className="px-2 py-1.5 text-gray-400">{e.kind}</td>
                  <td className="px-2 py-1.5 font-mono text-[10.5px] text-gray-400 break-all">{e.host}</td>
                  <td className="px-2 py-1.5 text-gray-400">{e.scope || '—'}</td>
                  <td className="px-2 py-1.5 text-gray-400">{e.variant || 'default'}</td>
                  <td className="px-2 py-1.5"><SourceTag entry={e} /></td>
                  <td className="px-2.5 py-1.5">
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] whitespace-nowrap ${STATE_CLS[state]}`}>
                      {t(STATE_KEY[state])}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3">
        <div className="text-[10.5px] font-bold uppercase tracking-wider text-gray-500 inline-flex items-center gap-1.5">
          <Lock className="w-3 h-3 text-amber-300" />{t('registry.lockedList')}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {locked.map((e) => (
            <span key={e.id}
              className="font-mono text-[10px] px-2 py-0.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300">
              {e.id}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
};

/* ─────────────────────────── ② 诊断与演练 ─────────────────────────── */

export const DiagnosticsEntry: React.FC = () => {
  const t = useT();
  const { entries, snap } = useRegistryDiagnostics();
  const items = usePageStore((s) => s.items);
  const values = usePageStore((s) => s.values);
  const setPage = usePageStore((s) => s.setPage);
  const activeTab = useProjectStore((s) => s.activeTab);
  const variants = useUiPrefsStore((s) => s.variants);
  const resetVariants = useUiPrefsStore((s) => s.resetAllPageVariants);
  const [busy, setBusy] = useState(false);
  // 故障注入：注册一条 render 抛错的条目到本面板槽位，用 ErrorBoundary 验证「只影响这一条」
  const undoRef = useRef<null | (() => void)>(null);
  const [injected, setInjected] = useState(false);

  // 卸载清理（审查 M4）：关掉本面板（或离开设置台）时把注入的故障条目注销。
  // 不做的话 `dev.broken-entry` 会永久留在模块级注册表里（locked 常驻、红色崩溃占位一直在），
  // 而本组件已卸载、`undoRef` 随之丢失 —— 重开面板时 `injected` 复位为 false、
  // 界面显示「注入故障条目」按钮，可崩溃占位还在，只能靠再注入一次（同 id 替换）拿回 undo。
  useEffect(() => () => { undoRef.current?.(); undoRef.current = null; }, []);

  /** 当前所在页（只用于展示；演练目标另有其人，见下） */
  const current = items.find((i) => i.id === activeTab);
  /**
   * 演练目标：第一个已开启的功能页。
   * 不能用「当前页」当目标 —— 本面板长在设置台里，当前页永远是设置页，
   * 而设置页是锁定页、后端也拒绝停用（停用它等于把开关面板自己关掉）。
   * 于是演练改为「真实停用某一个已开启的页面」，模拟别的窗口 / 机器把它关掉：
   * 侧栏入口消失、接口 404，回上面的「页面开关」分区即可再打开。
   */
  const drillTarget = items.find((i) => i.id !== 'config' && values[i.id] === true);
  const changedVariants = Object.entries(variants);

  const enableCount = (v: Record<string, boolean>) => Object.values(v).filter(Boolean).length;

  const drillDisablePage = async () => {
    if (!drillTarget) return;
    const ok = await confirmAsync({
      title: t('diag.confirmTitle'),
      isDanger: true,
      confirmText: t('diag.disableCurrent'),
      cancelText: 'Cancel',
      message: t('diag.confirmBody', { label: drillTarget.label }),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await setPage(drillTarget.id, false);
      toast.info(t('diag.drillDone', { label: drillTarget.label }));
    } catch (e: any) {
      toast.error(e?.message || 'failed');
    } finally {
      setBusy(false);
    }
  };

  const resetToFallback = () => {
    resetVariants();
    toast.success(t('diag.resetDone'));
  };

  /**
   * 手刷兜底（设计 §4 Phase 4 / 未完成清单第 11 条）：SSE 断线时手动重播一轮扩展刷新事件。
   * 刻意不做「重拉中…」的 busy 态：广播是同步的、各宿主各自异步重拉，
   * 这里只知道「已发出」，假装知道结果反而是在骗用户。
   */
  const refreshExtensions = () => {
    refreshExtensionState();
    toast.info(t('diag.refreshExtDone'));
  };

  const injectBroken = () => {
    if (undoRef.current) return;
    undoRef.current = register({
      id: 'dev.broken-entry',
      kind: 'panel',
      host: SETTINGS_PANELS_HOST,
      order: 999,
      locked: true, // 不绑开关，注入即渲染
      source: 'builtin',
      render: () => { throw new Error('故障注入：这条 render 是故意抛错的'); },
    });
    setInjected(true);
    toast.warning(t('diag.injected'));
  };

  const removeBroken = () => {
    undoRef.current?.();
    undoRef.current = null;
    setInjected(false);
    toast.info(t('diag.injectRemoved'));
  };

  return (
    <section className={`${GLASS} rounded-2xl px-5 py-4`}>
      <div className="flex items-center gap-2 flex-wrap">
        <Activity className="w-4 h-4 text-gray-500" />
        <h3 className="text-[13px] font-bold text-[color:var(--color-text-main)]">{t('panel.diag.label')}</h3>
        <span className="font-mono text-[9.5px] tracking-[.16em] uppercase text-gray-500">DIAGNOSTICS</span>
      </div>

      {/* 只读诊断 */}
      <div className="mt-3 grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <div className="rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 px-3 py-2">
          <div className="font-mono text-[9.5px] uppercase tracking-[.12em] text-gray-500">{t('diag.pages')}</div>
          <div className="mt-0.5 text-[12px] text-[color:var(--color-text-main)]">
            {enableCount(values)} / {items.length}
          </div>
        </div>
        <div className="rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 px-3 py-2">
          <div className="font-mono text-[9.5px] uppercase tracking-[.12em] text-gray-500">{t('diag.features')}</div>
          <div className="mt-0.5 text-[12px] text-[color:var(--color-text-main)]">{enableCount(snap.features)}</div>
        </div>
        <div className="rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 px-3 py-2">
          <div className="font-mono text-[9.5px] uppercase tracking-[.12em] text-gray-500">{t('diag.prefs')}</div>
          <div className="mt-0.5 text-[12px] text-[color:var(--color-text-main)]">{enableCount(snap.prefs)}</div>
        </div>
        <div className="rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 px-3 py-2">
          <div className="font-mono text-[9.5px] uppercase tracking-[.12em] text-gray-500">{t('diag.registryCount')}</div>
          <div className="mt-0.5 text-[12px] text-[color:var(--color-text-main)]">{entries.length}</div>
        </div>
        <div className="rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 px-3 py-2">
          <div className="font-mono text-[9.5px] uppercase tracking-[.12em] text-gray-500">{t('diag.currentIs')}</div>
          <div className="mt-0.5 text-[12px] text-[color:var(--color-text-main)] truncate">{current?.label || t('diag.none')}</div>
        </div>
        <div className="rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 px-3 py-2">
          <div className="font-mono text-[9.5px] uppercase tracking-[.12em] text-gray-500">{t('diag.variants')}</div>
          <div className="mt-0.5 text-[12px] text-[color:var(--color-text-main)] truncate">
            {changedVariants.length === 0 ? t('diag.none') : changedVariants.map(([k, v]) => `${k}@${v}`).join(' · ')}
          </div>
        </div>
      </div>

      {/* 演练动作 */}
      <div className="mt-3.5 flex flex-col gap-2.5">
        <div className="flex items-start gap-2.5 flex-wrap">
          <button
            onClick={drillDisablePage}
            disabled={!drillTarget || busy}
            className="h-8 px-3 rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 text-[11.5px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Power className="w-3.5 h-3.5" />{t('diag.disableCurrent')}
          </button>
          <p className="text-[10.5px] text-gray-500 leading-relaxed flex-1 min-w-[220px]">
            {drillTarget
              ? t('diag.disableCurrentTip', { label: drillTarget.label })
              : t('diag.noCurrent')}
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            onClick={resetToFallback}
            disabled={changedVariants.length === 0}
            className="h-8 px-3 rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 text-[11.5px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />{t('diag.reset')}
          </button>
          <span className="font-mono text-[10px] text-gray-500">{changedVariants.length} changed</span>
        </div>

        {/* 手刷兜底（第 11 条）：SSE 不可用时的「再来一次」，与自动推送同一份刷新事件表 */}
        <div className="flex items-start gap-2.5 flex-wrap">
          <button
            onClick={refreshExtensions}
            className="h-8 px-3 rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 text-[11.5px] font-semibold inline-flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />{t('diag.refreshExt')}
          </button>
          <p className="text-[10.5px] text-gray-500 leading-relaxed flex-1 min-w-[220px]">{t('diag.refreshExtTip')}</p>
        </div>

        {/* 故障注入只在开发模式出现：生产环境没有「故意抛错的条目」这种东西 */}
        {import.meta.env.DEV && (
          <div className="flex items-start gap-2.5 flex-wrap">
            {injected ? (
              <button
                onClick={removeBroken}
                className="h-8 px-3 rounded-xl border border-red-500/40 bg-red-500/10 text-[11.5px] font-semibold text-red-300 inline-flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />{t('diag.injectRemove')}
              </button>
            ) : (
              <button
                onClick={injectBroken}
                className="h-8 px-3 rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 text-[11.5px] font-semibold inline-flex items-center gap-1.5"
              >
                <Bug className="w-3.5 h-3.5" />{t('diag.inject')}
              </button>
            )}
            <p className="text-[10.5px] text-gray-500 leading-relaxed flex-1 min-w-[220px]">{t('diag.injectTip')}</p>
          </div>
        )}
      </div>

      {/* 数据来源提示：面板本身也是注册表条目，状态由 prefs 层决定 */}
      <div className="mt-3 font-mono text-[10px] text-gray-500 flex items-center gap-1.5">
        <RefreshCw className="w-3 h-3" />host: {SETTINGS_PANELS_HOST} · scope: prefs
      </div>
    </section>
  );
};

/** 两个面板条目：prefs 层，默认关（本机偏好，不影响后端能力） */
function registerConsolePanels(): () => void {
  const undo = [
    register({
      id: 'panel.registry',
      kind: 'panel',
      host: SETTINGS_PANELS_HOST,
      order: 10,
      scope: 'prefs',
      switchId: 'settings_registry_view',
      source: 'builtin',
      render: RegistryViewEntry,
    }),
    register({
      id: 'panel.diagnostics',
      kind: 'panel',
      host: SETTINGS_PANELS_HOST,
      order: 20,
      scope: 'prefs',
      switchId: 'settings_diagnostics',
      source: 'builtin',
      render: DiagnosticsEntry,
    }),
  ];
  return () => undo.forEach((fn) => fn());
}

registerConsolePanels();
