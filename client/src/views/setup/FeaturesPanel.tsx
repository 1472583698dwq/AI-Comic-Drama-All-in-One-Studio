import React, { useEffect, useState } from 'react';
import {
  Loader2, RefreshCw, Lock, ArrowRight, Power, Layers, ImagePlus, GitBranch, UsersRound, Puzzle,
} from 'lucide-react';
import { usePageStore, resolveTab } from '../../stores/usePageStore';
import { useFeatureStore, type FeatureItem } from '../../stores/useFeatureStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { toast } from '../../stores/useDialogStore';
import { pageIcon } from '../../utils/pageIcons';

/** 无项目时也能进的全局页（其余页面需要先有项目才能前往） */
const GLOBAL_TABS = ['home', 'projects', 'config'];

/**
 * 功能开关面板按 id 关键词挑图标（功能项契约里没有 icon 字段），
 * 认不出来一律回落通用插件图标 —— 绝不因新增开关项而崩。
 * 注意：页面图标映射（utils/pageIcons）不在这里改。
 */
const FEATURE_ICON_RULES: Array<[RegExp, any]> = [
  [/multimodal|vision|image|attach|media/, ImagePlus],
  [/subagent|sub_agent|delegat|branch/, GitBranch],
  [/team|cluster|group|profile/, UsersRound],
];

const featureIcon = (it: FeatureItem) => {
  const k = String(it.id || '').toLowerCase();
  return FEATURE_ICON_RULES.find(([re]) => re.test(k))?.[1] || Puzzle;
};

/**
 * 功能开关（设置 → 功能开关）：两层开关一个面板。
 *
 * 分区一「页面开关」—— 管「看不看得见这一页」。数据源与准入唯一口径都是后端 `/api/v1/pages`
 * （前端不缓存、不猜默认值）：打开即生效 —— 侧栏出现入口、页签可直达、后端对应能力族接口恢复；
 * 关闭即关干净 —— 入口隐藏、页签归一回落、接口返回 404。设置（config）是 locked 系统页，只展示不可切。
 *
 * 分区二「功能开关」—— 管「这一页里的进阶能力开不开」。数据源是后端 `/api/v1/features`
 * （非页面级进阶能力，默认全关）：关闭 `agent_teams` → agent-teams / agent-profiles 接口 404；
 * 关闭 `agent_multimodal` → Agent 附件退化为纯文本；关闭 `agent_subagent` → 子代理委派直接失败。
 * 影响范围文案只取后端 description，前端不自行编造。
 */
export const FeaturesPanel: React.FC = () => {
  const items = usePageStore((s) => s.items);
  const values = usePageStore((s) => s.values);
  const file = usePageStore((s) => s.file);
  const loading = usePageStore((s) => s.loading);
  const error = usePageStore((s) => s.error);
  const load = usePageStore((s) => s.load);
  const setPage = usePageStore((s) => s.setPage);

  const features = useFeatureStore((s) => s.items);
  const featureValues = useFeatureStore((s) => s.values);
  const featureFile = useFeatureStore((s) => s.file);
  const featureLoading = useFeatureStore((s) => s.loading);
  const featureError = useFeatureStore((s) => s.error);
  const loadFeatures = useFeatureStore((s) => s.load);
  const setFeature = useFeatureStore((s) => s.setFeature);

  const activeTab = useProjectStore((s) => s.activeTab);
  const project = useProjectStore((s) => s.project);
  const [busy, setBusy] = useState<string | null>(null);
  const [featBusy, setFeatBusy] = useState<string | null>(null);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadFeatures(); }, [loadFeatures]);

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

  /** 功能开关：失败（后端 400 / 网络错误）提示并回滚 —— 重拉后端，本地不留假状态 */
  const toggleFeature = async (id: string, label: string, next: boolean) => {
    setFeatBusy(id);
    try {
      await setFeature(id, next);
      if (next) {
        toast.success(`已开启「${label}」，该能力即时生效`);
      } else {
        toast.info(`已关闭「${label}」，相关能力已停用`);
      }
    } catch (e: any) {
      toast.error(e?.message || '切换失败');
      try { await loadFeatures(); } catch { /* 回滚失败仍保留错误提示 */ }
    } finally {
      setFeatBusy(null);
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
          两层开关：<span className="text-gray-300">页面开关</span>管「看不看得见这一页」，关掉后左侧栏没有入口、接口也进不去；
          <span className="text-gray-300">功能开关</span>管「这一页里的进阶能力开不开」，页面照常在，只是页内的某些能力按开关走。
          两者都是改完即时生效、无需重启。
        </p>
      </div>

      {/* ── 分区一：页面开关（页面级，管入口可见性） ── */}
      <section className="flex flex-col gap-2.5">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-[color:var(--color-text-main)]">
            <Layers className="w-3.5 h-3.5 text-gray-500" />页面开关
          </span>
          <span className="text-[10.5px] text-gray-500">管「看不看得见这一页」—— 入口、页签与接口准入</span>
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
      </section>

      {/* ── 分区二：功能开关（能力级，管页内进阶能力） ── */}
      <section className="flex flex-col gap-2.5">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-[color:var(--color-text-main)]">
            <Power className="w-3.5 h-3.5 text-gray-500" />功能开关
          </span>
          <span className="text-[10.5px] text-gray-500">管「这一页里的进阶能力开不开」—— 非页面级能力，默认全关</span>
        </div>

        {featureError && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-[11.5px] text-amber-300 flex items-center justify-between gap-3">
            <span>读取功能开关失败：{featureError}（当前按「全部关闭」显示，与你上次保存的状态可能不一致）</span>
            <button onClick={() => loadFeatures()} className="shrink-0 px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 flex items-center gap-1">
              <RefreshCw className="w-3 h-3" />重试
            </button>
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          {features.length === 0 && (
            <div className="rounded-xl border border-border bg-surface-secondary px-3.5 py-3 text-[11.5px] text-gray-500 flex items-center gap-2">
              {featureLoading
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />读取中…</>
                : featureError ? '读取失败，暂无可切换的功能' : '没有可切换的功能'}
            </div>
          )}

          {features.map((it) => {
            const Icon = featureIcon(it);
            const enabled = featureValues[it.id] === true;
            const working = featBusy === it.id;
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
                    <span className="text-[10px] text-gray-500">出厂默认{it.default ? '开启' : '关闭'}</span>
                  </div>

                  {it.description && (
                    <p className="mt-1 text-[10.5px] text-gray-500 leading-relaxed">关闭后：{it.description}</p>
                  )}
                </div>

                <button
                  onClick={() => toggleFeature(it.id, it.label, !enabled)}
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
              </div>
            );
          })}
        </div>
      </section>

      {/* 脚注：两处落盘位置写明，改配置出问题时知道去哪儿看 */}
      <div className="flex flex-col gap-1">
        <p className="text-[10.5px] text-gray-500 leading-relaxed">
          页面开关存储：{file || 'state.json'}（改完即时生效，无需重启）
        </p>
        {featureFile && (
          <p className="text-[10.5px] text-gray-500 leading-relaxed">
            功能开关存储：{featureFile}（改完即时生效，无需重启）
          </p>
        )}
      </div>
    </div>
  );
};

export default FeaturesPanel;
