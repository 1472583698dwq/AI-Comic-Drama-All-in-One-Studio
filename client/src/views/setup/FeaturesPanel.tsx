import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight, Activity, Eye, GitBranch, Languages, Layers, ListTree, Lock, Package, Power, SlidersHorizontal,
} from 'lucide-react';
import { apiService } from '../../services/api';
import { usePageStore, resolveTab } from '../../stores/usePageStore';
import { isGlobalPage } from '../../ui-registry/pageTabs';
import { useFeatureStore, type FeatureItem } from '../../stores/useFeatureStore';
import { UI_SWITCH_DEFS, useUiPrefsStore, PAGE_VARIANT_PREFIX, type UiSwitchItem } from '../../stores/useUiPrefsStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { toast } from '../../stores/useDialogStore';
import { pageIcon } from '../../utils/pageIcons';
import { T_MAIN } from '../../components/ui/designKit';
import { usePageVariants } from '../../ui-registry/entries/pageVariants';
import { DEFAULT_VARIANT, SETTINGS_PANELS_HOST } from '../../ui-registry/types';
import { variantDescription, variantLabel, VARIANT_ORDER } from '../../ui-registry/entries/variants';
import { useT } from '../../ui-registry/i18n';
import { UISlot } from '../../ui-registry/UISlot';
import { CardTag, ConsoleCard, ConsoleSection, SectionEmpty, SectionError } from './ConsoleCard';

/** 无项目时也能进的全局页见 ui-registry/pageTabs 的 globalPageIds() */
/** 核心界面不作为可关闭的功能页：AI 对话（agent）的入口是「新建任务」与聊天历史 */
const HIDDEN_PAGE_IDS = ['agent'];

/**
 * 功能开关面板按 id 关键词挑图标（功能项契约里没有 icon 字段），
 * 认不出来一律回落通用插件图标 —— 绝不因新增开关项而崩。
 * 注意：页面图标映射（utils/pageIcons）不在这里改。
 */
const FEATURE_ICON_RULES: Array<[RegExp, any]> = [
  [/multimodal|vision|image|attach|media/, SlidersHorizontal],
  [/subagent|sub_agent|delegat|branch/, GitBranch],
  [/team|cluster|group|profile/, Package],
];

const featureIcon = (it: FeatureItem) => {
  const k = String(it.id || '').toLowerCase();
  return FEATURE_ICON_RULES.find(([re]) => re.test(k))?.[1] || Package;
};

/** UI 开关项按 id 关键词挑图标，认不出来一律回落侧栏图标（新增开关项不会崩） */
const UI_ICON_RULES: Array<[RegExp, any]> = [
  [/settings_registry|registry|注册表/, ListTree],
  [/settings_diagnostics|diagnos|诊断/, Activity],
  [/annotate|annot|标注/, Eye],
  [/sidebar|侧栏|panel|history|chat/, Layers],
];

const uiSwitchIcon = (it: UiSwitchItem) => {
  const k = `${it.id} ${it.label}`.toLowerCase();
  return UI_ICON_RULES.find(([re]) => re.test(k))?.[1] || Layers;
};

/** 插件贡献清单：`contributions`（带数量的 6 类）+ `deferred`（其余 6 类的声明） */
const CONTRIB_LABEL: Record<string, string> = {
  providers: '生成源', skills: '技能', workflows: '工作流', mcp_tools: 'MCP 工具',
  custom_nodes: '代码节点', storyboard_slots: '分镜槽', canvas_nodes: '画布节点',
  director_packs: '导演包', exporters: '导出器', themes: '主题',
  agent_profiles: '导演组成员', agent_teams: '导演组',
};

const contribTags = (p: any): string[] => {
  const out: string[] = [];
  Object.entries(p?.contributions || {}).forEach(([k, v]) => {
    const n = Array.isArray(v) ? v.length : Number(v) || 0;
    if (n > 0) out.push(`${CONTRIB_LABEL[k] || k} ${n}`);
  });
  Object.keys(p?.deferred || {}).forEach((k) => out.push(CONTRIB_LABEL[k] || k));
  return out;
};

/**
 * 前端版本卡片：一个页面 = 一张卡，页脚是版本单选。
 *
 * 版本列表读**注册表**（`usePageVariants`），不是读常量表 —— 列出来的永远是「真的有条目的版本」，
 * 不会出现「切了没反应」。只有一个版本的页面直接不展示（没有可选项）。
 */
const VariantCard: React.FC<{ index: number; pageId: string; label: string; icon?: string }> = ({ index, pageId, label, icon }) => {
  const t = useT();
  const options = usePageVariants(pageId);
  const variants = useUiPrefsStore((s) => s.variants);
  const setPageVariant = useUiPrefsStore((s) => s.setPageVariant);
  if (options.length < 2) return null;

  const active = variants[pageId] || DEFAULT_VARIANT;

  const pick = (id: string) => {
    if (id === active) return;
    setPageVariant(pageId, id);
    toast.success(id === DEFAULT_VARIANT
      ? t('toast.variantFallback', { page: label })
      : t('toast.variantSwitched', { page: label, v: variantLabel(id) }));
  };

  return (
    <ConsoleCard
      index={index}
      icon={React.createElement(pageIcon(pageId, icon), { className: 'w-5 h-5' })}
      title={label}
      sub={`${t('variant.of')} · ${active}`}
      desc={`${t('card.current')}: ${variantLabel(active)}`}
      tags={<CardTag text={variantLabel(active)} tone={active === DEFAULT_VARIANT ? 'lock' : 'plugin'} />}
      footer={(
        <div className="flex gap-1.5 flex-wrap justify-end">
          {[...options].sort((a, b) => VARIANT_ORDER.indexOf(a.id) - VARIANT_ORDER.indexOf(b.id)).map((v) => {
            const on = v.id === active;
            return (
              <button
                key={v.id}
                onClick={() => pick(v.id)}
                title={v.description || variantDescription(v.id)}
                aria-pressed={on}
                className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors whitespace-nowrap ${
                  on ? 'bg-brand text-white border-brand'
                     : 'bg-surface/80 border-white/70 dark:border-white/12 text-gray-400 hover:text-[color:var(--color-text-main)]'
                }`}
              >
                {v.label}
                {v.id === DEFAULT_VARIANT && <Lock className="ml-1 w-2.5 h-2.5 inline" />}
              </button>
            );
          })}
        </div>
      )}
    />
  );
};

/**
 * 功能开关（设置 → 功能开关）：**开关注册台**——五类开关一个面板，全部大卡片。
 *
 * ① 页面开关 —— 管「看不看得见这一页」。真相源是后端 `/api/v1/pages`（前端不缓存、不猜默认值）：
 *    打开即生效（侧栏入口出现、后端接口恢复），关闭即关干净（入口隐藏、页签归一回落、接口 404）。
 * ② 功能开关 —— 管「这一页里的进阶能力开不开」。真相源后端 `/api/v1/features`，出厂默认全关。
 * ③ UI 偏好 —— 纯本机呈现偏好（localStorage），不碰后端能力与接口准入。
 * ④ 插件 —— 第 4 类开关：一个包的全部贡献整体上下线。列表读 `/extensions` 的插件发现结果，
 *    开关走后端 enable/disable（与「设置 → 扩展」是同一份真相源，互不新增契约）。
 * ⑤ 前端版本 —— 管「这一页用哪一版界面」。本机单选（`page_variant.<页面 id>`），
 *    当前实现登记为「测试初期版本（保底）」默认激活，重构新版以占位条目登记。
 *
 * ⑥ 注册表视图 / 诊断面板：两个 prefs 层的可插拔面板（默认关），由 `UISlot` 渲染 ——
 *    它们是注册表条目（`panel.registry` / `panel.diagnostics`），面板自己开不开也走开关。
 *
 * 界面语言（中 / EN）只覆盖本面板与它引入的面板 / toast / 空态自救页；顶栏、侧栏与各功能页
 * 的既有文案不在本轮范围。
 */
export const FeaturesPanel: React.FC = () => {
  const t = useT();
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

  const uiValues = useUiPrefsStore((s) => s.values);
  const setUiSwitch = useUiPrefsStore((s) => s.setUiSwitch);
  const lang = useUiPrefsStore((s) => s.lang);
  const setLang = useUiPrefsStore((s) => s.setLang);

  const activeTab = useProjectStore((s) => s.activeTab);
  const project = useProjectStore((s) => s.project);
  const [busy, setBusy] = useState<string | null>(null);
  const [featBusy, setFeatBusy] = useState<string | null>(null);

  // 插件分区：列表与开关都走后端插件端点（与「设置 → 扩展」同一真相源）
  const [plugins, setPlugins] = useState<any[]>([]);
  const [pluginLoading, setPluginLoading] = useState(true);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadFeatures(); }, [loadFeatures]);

  // 注意：状态更新全部发生在 await 之后，函数开头不同步置 loading
  //（初始值就是 true；重试时由点击事件自己置位）——effect 里不产生同步状态更新
  const loadPlugins = useCallback(async () => {
    try {
      const p: any = await apiService.listPlugins();
      setPlugins(Array.isArray(p?.plugins) ? p.plugins : []);
      setPluginError(null);
    } catch (e: any) {
      // 后端不可达时不写假状态：清空列表 + 明示错误 + 给重试
      setPlugins([]);
      setPluginError(e?.message || 'failed');
    }
    setPluginLoading(false);
  }, []);

  /** 手动重试：先亮「读取中」再拉（事件里改状态，不触发上面的规则） */
  const retryPlugins = () => { setPluginLoading(true); void loadPlugins(); };

  useEffect(() => {
    void loadPlugins();
    const h = () => { void loadPlugins(); };
    window.addEventListener('plugin-list-refresh', h);
    return () => window.removeEventListener('plugin-list-refresh', h);
  }, [loadPlugins]);

  const toggle = async (id: string, label: string, next: boolean) => {
    setBusy(id);
    try {
      await setPage(id, next);
      toast[next ? 'success' : 'info'](next
        ? t('toast.pageOn', { label })
        : t('toast.pageOff', { label }));
      // 关掉的正好是当前所在页 → 立刻按可用性回落（App 侧还有一层归一兜底）
      if (!next && activeTab === id) {
        const nextTab = resolveTab(activeTab);
        if (nextTab) useProjectStore.getState().setActiveTab(nextTab as any);
      }
    } catch (e: any) {
      toast.error(e?.message || t('toast.toggleFailed'));
    } finally {
      setBusy(null);
    }
  };

  /** 功能开关：失败（后端 400 / 网络错误）提示并回滚 —— 重拉后端，本地不留假状态 */
  const toggleFeature = async (id: string, label: string, next: boolean) => {
    setFeatBusy(id);
    try {
      await setFeature(id, next);
      toast[next ? 'success' : 'info'](next
        ? t('toast.featureOn', { label })
        : t('toast.featureOff', { label }));
    } catch (e: any) {
      toast.error(e?.message || t('toast.toggleFailed'));
      try { await loadFeatures(); } catch { /* 回滚失败仍保留错误提示 */ }
    } finally {
      setFeatBusy(null);
    }
  };

  /** UI 开关：纯本机界面偏好，写 localStorage 即生效 —— 没有失败路径，也不必回滚 */
  const toggleUiSwitch = (id: string, label: string, next: boolean) => {
    setUiSwitch(id, next);
    toast[next ? 'success' : 'info'](next
      ? t('toast.prefOn', { label })
      : t('toast.prefOff', { label }));
  };

  /** 插件启停：后端是唯一真相源，成功后重拉列表 + 通知其它宿主（扩展页 / 主题 / 画布节点等） */
  const togglePlugin = async (p: any) => {
    setPluginBusy(p.id);
    try {
      await apiService.setPluginEnabled(p.id, !p.enabled);
      toast[!p.enabled ? 'success' : 'info'](t(!p.enabled ? 'plugin.on' : 'plugin.off', { name: p.name }));
      await loadPlugins();
      try { window.dispatchEvent(new Event('plugin-list-refresh')); } catch { /* ignore */ }
    } catch (e: any) {
      toast.error(e?.message || t('toast.toggleFailed'));
    } finally {
      setPluginBusy(null);
    }
  };

  const go = (id: string) => {
    if (!isGlobalPage(id) && !project) {
      toast.info(t('toast.needProject'));
      return;
    }
    useProjectStore.getState().setActiveTab(id as any);
  };

  const pageCards = items.filter((it) => !HIDDEN_PAGE_IDS.includes(it.id));

  return (
    <div className="flex flex-col gap-6">
      {/* ── 注册台抬头（原型：标题 + 英文小标 + 语言切换） ── */}
      <header className="flex flex-col gap-2">
        <div className="flex items-end gap-3 flex-wrap">
          <h1 className={`text-[21px] font-bold ${T_MAIN} leading-none`}>{t('console.title')}</h1>
          <span className="font-mono text-[9.5px] uppercase tracking-[.2em] text-gray-500 pb-0.5">{t('console.sub')}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <Languages className="w-3.5 h-3.5 text-gray-500" />
            {(['zh', 'en'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                aria-pressed={lang === l}
                className={`h-6 px-2.5 rounded-lg text-[11px] font-mono border transition-colors ${
                  lang === l ? 'bg-brand text-white border-brand'
                             : 'bg-surface/80 border-white/70 dark:border-white/12 text-gray-400 hover:text-[color:var(--color-text-main)]'
                }`}
              >
                {l === 'zh' ? '中' : 'EN'}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[11.5px] text-gray-400 leading-relaxed">{t('console.intro')}</p>
      </header>

      {/* ── ① 页面开关 ── */}
      <ConsoleSection
        icon={<Layers className="w-3.5 h-3.5 text-gray-500" />}
        title={t('sec.page.label')}
        sub={t('sec.page.sub')}
        count={`${pageCards.filter((it) => values[it.id] === true).length}/${pageCards.length}`}
      >
        {error && (
          <div className="[grid-column:1/-1]">
            <SectionError text={`${t('common.readFailed')}${error}`} onRetry={() => load()} retryText={t('common.retry')} />
          </div>
        )}
        {pageCards.length === 0 && !error && (
          <div className="[grid-column:1/-1]">
            <SectionEmpty text={t('common.none')} spinning={loading} />
          </div>
        )}
        {pageCards.map((it, i) => {
          const enabled = values[it.id] === true;
          const locked = it.locked === true;
          return (
            <ConsoleCard
              key={it.id}
              index={i + 1}
              icon={React.createElement(pageIcon(it.id, it.icon), { className: 'w-5 h-5' })}
              title={it.label}
              sub={`page · ${it.id}${it.host && it.host !== it.id ? ` (host: ${it.host})` : ''}`}
              desc={it.description || undefined}
              checked={enabled}
              locked={locked}
              busy={busy === it.id}
              toggleTitle={enabled ? `${t('card.on')} · ${it.id}` : `${t('card.off')} · ${it.id}`}
              onToggle={(next) => toggle(it.id, it.label, next)}
              tags={(
                <>
                  <CardTag text={enabled ? t('card.on') : t('card.off')} tone={enabled ? 'on' : 'off'} />
                  {locked && <CardTag text={t('card.lockedHint')} tone="lock" />}
                  {it.default && !locked && <CardTag text={enabled ? t('card.defaultOn') : t('card.defaultOff')} />}
                </>
              )}
              extra={enabled ? (
                <button
                  onClick={() => go(it.id)}
                  className="self-start px-2.5 py-1 rounded-lg text-[11px] bg-brand text-white hover:bg-brand-light inline-flex items-center gap-1"
                >
                  {t('card.goto')}{it.label}<ArrowRight className="w-3 h-3" />
                </button>
              ) : (
                <span
                  title={t('card.gotoBlocked')}
                  className="self-start px-2.5 py-1 rounded-lg text-[11px] border border-white/70 dark:border-white/12 bg-surface/80 text-gray-500 inline-flex items-center gap-1 cursor-not-allowed"
                >
                  <Lock className="w-3 h-3" />{t('card.gotoBlocked')}
                </span>
              )}
            />
          );
        })}
      </ConsoleSection>

      {/* ── ② 功能开关 ── */}
      <ConsoleSection
        icon={<Power className="w-3.5 h-3.5 text-gray-500" />}
        title={t('sec.feature.label')}
        sub={t('sec.feature.sub')}
        count={`${features.filter((it) => featureValues[it.id] === true).length}/${features.length}`}
      >
        {featureError && (
          <div className="[grid-column:1/-1]">
            <SectionError
              text={`${t('common.readFailed')}${featureError}`}
              onRetry={() => loadFeatures()}
              retryText={t('common.retry')}
            />
          </div>
        )}
        {features.length === 0 && (
          <div className="[grid-column:1/-1]">
            <SectionEmpty text={t('common.none')} spinning={featureLoading} />
          </div>
        )}
        {features.map((it, i) => {
          const enabled = featureValues[it.id] === true;
          return (
            <ConsoleCard
              key={it.id}
              index={i + 1}
              icon={React.createElement(featureIcon(it), { className: 'w-5 h-5' })}
              title={it.label}
              sub={`feature · ${it.id}`}
              desc={it.description ? `${t('card.off')} → ${it.description}` : undefined}
              checked={enabled}
              busy={featBusy === it.id}
              onToggle={(next) => toggleFeature(it.id, it.label, next)}
              tags={(
                <>
                  <CardTag text={enabled ? t('card.on') : t('card.off')} tone={enabled ? 'on' : 'off'} />
                  <CardTag text={enabled ? t('card.defaultOn') : t('card.defaultOff')} />
                </>
              )}
            />
          );
        })}
      </ConsoleSection>

      {/* ── ③ UI 偏好 ── */}
      <ConsoleSection
        icon={<Eye className="w-3.5 h-3.5 text-gray-500" />}
        title={t('sec.prefs.label')}
        sub={t('sec.prefs.sub')}
        count={`${UI_SWITCH_DEFS.filter((it) => uiValues[it.id] === true).length}/${UI_SWITCH_DEFS.length}`}
      >
        {UI_SWITCH_DEFS.map((it, i) => {
          const enabled = uiValues[it.id] === true;
          return (
            <ConsoleCard
              key={it.id}
              index={i + 1}
              icon={React.createElement(uiSwitchIcon(it), { className: 'w-5 h-5' })}
              title={it.label}
              sub={`prefs · ${it.id}`}
              desc={it.description ? `${t('card.off')} → ${it.description}` : undefined}
              checked={enabled}
              onToggle={(next) => toggleUiSwitch(it.id, it.label, next)}
              tags={(
                <>
                  <CardTag text={enabled ? t('card.shown') : t('card.hidden')} tone={enabled ? 'on' : 'off'} />
                  <CardTag text={enabled ? t('card.defaultShown') : t('card.defaultHidden')} />
                </>
              )}
            />
          );
        })}
      </ConsoleSection>

      {/* ── ④ 插件（第 4 类开关：一个包的全部贡献整体上下线） ── */}
      <ConsoleSection
        icon={<Package className="w-3.5 h-3.5 text-gray-500" />}
        title={t('sec.plugin.label')}
        sub={t('sec.plugin.sub')}
        count={`${plugins.filter((p) => p.enabled).length}/${plugins.length}`}
      >
        {pluginError && (
          <div className="[grid-column:1/-1]">
            <SectionError
              text={`${t('plugin.failed')}：${pluginError}`}
              onRetry={retryPlugins}
              retryText={t('common.retry')}
            />
          </div>
        )}
        {!pluginError && plugins.length === 0 && (
          <div className="[grid-column:1/-1]">
            <SectionEmpty
              text={pluginLoading ? t('plugin.loading') : `${t('plugin.empty')} —— ${t('plugin.emptyHint')}`}
              spinning={pluginLoading}
            />
          </div>
        )}
        {plugins.map((p, i) => (
          <ConsoleCard
            key={p.id}
            index={i + 1}
            icon={<Package className="w-5 h-5" />}
            title={p.name || p.id}
            sub={`plugin · v${p.version || '?'}${p.author ? ` · ${p.author}` : ''}`}
            desc={p.description || p.id}
            checked={!!p.enabled}
            busy={pluginBusy === p.id}
            onToggle={() => { void togglePlugin(p); }}
            tags={(
              <>
                <CardTag text={p.enabled ? t('plugin.enabled') : t('plugin.disabled')} tone={p.enabled ? 'on' : 'off'} />
                <CardTag text={p.id} tone="plugin" />
                {contribTags(p).map((c) => <CardTag key={c} text={c} tone="plugin" />)}
              </>
            )}
          />
        ))}
      </ConsoleSection>

      {/* ── ⑤ 前端版本 ── */}
      <ConsoleSection
        icon={<GitBranch className="w-3.5 h-3.5 text-gray-500" />}
        title={t('sec.variant.label')}
        sub={t('sec.variant.sub')}
        count={`${items.length}`}
        hint={t('variant.hint')}
      >
        {items.map((it, i) => (
          <VariantCard key={it.id} index={i + 1} pageId={it.id} label={it.label} icon={it.icon} />
        ))}
      </ConsoleSection>

      {/* ── ⑥ 可插拔面板（prefs 层，默认关）：注册表视图 / 诊断与演练 ── */}
      <UISlot host={SETTINGS_PANELS_HOST} />

      {/* 脚注：三处落盘位置写明，改配置出问题时知道去哪儿看 */}
      <div className="flex flex-col gap-1">
        <p className="text-[10.5px] text-gray-500 leading-relaxed">
          {t('common.storageNote')}{file || 'state.json'}{t('common.instant')}
        </p>
        {featureFile && (
          <p className="text-[10.5px] text-gray-500 leading-relaxed">
            {t('common.storageNote')}{featureFile}{t('common.instant')}
          </p>
        )}
        <p className="text-[10.5px] text-gray-500 leading-relaxed">
          {t('common.storageNote')}{t('common.thisDevice')}{t('common.instant')}
        </p>
        <p className="text-[10.5px] text-gray-500 leading-relaxed">
          {t('common.storageNote')}{PAGE_VARIANT_PREFIX}&lt;pageId&gt;
        </p>
      </div>
    </div>
  );
};

export default FeaturesPanel;
