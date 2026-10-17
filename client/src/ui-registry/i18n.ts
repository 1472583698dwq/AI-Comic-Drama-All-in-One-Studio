import { useCallback } from 'react';
import { useUiPrefsStore } from '../stores/useUiPrefsStore';

/**
 * 最小形态 / 开关注册台的中英文案表（设置 → 功能开关 这一片界面用）。
 *
 * 覆盖范围**有意限定**在本轮新增与改造的界面：设置台（五个分区 + 大卡片）、
 * 注册表视图 / 诊断面板、标注模式图例、空态自救页、以及本系列新增的 toast。
 * 顶栏 / 侧栏 / 11 个功能页的既有文案**不做双语**（那是独立议题，不在本轮范围）。
 *
 * 取词一律走 `useT()`（订阅 prefs 里的 `ui_lang`），缺 key 时回落 key 本身，
 * 这样新增卡片先写 key 也不会把界面变成空白。
 */

type Pair = { zh: string; en: string };

export const UI_TEXT = {
  /* ── 设置台抬头 ── */
  'console.title': { zh: '功能开关', en: 'Switchboard' },
  'console.sub': { zh: '页面 · 能力 · 偏好 · 插件 · 版本', en: 'pages · features · prefs · plugins · variants' },
  'console.intro': {
    zh: '五类开关一处管：页面开关管「看不看得见这一页」，功能开关管「页内进阶能力开不开」，UI 偏好只改本机界面，插件开关管一个包的全部贡献一起上下线，前端版本管「这一页用哪一版界面」。全部改完即时生效，无需重启。',
    en: 'Five families in one place — pages (reachability), features (in-page capabilities), prefs (this device only), plugins (a whole pack on/off), variants (which UI implementation). Everything applies instantly, no restart.',
  },

  /* ── 分区标题 ── */
  'sec.page.label': { zh: '页面开关', en: 'PAGES' },
  'sec.page.sub': { zh: '入口 · 页签 · 接口准入', en: 'entry · tab · API admission' },
  'sec.feature.label': { zh: '功能开关', en: 'FEATURES' },
  'sec.feature.sub': { zh: '页内进阶能力，默认全关', en: 'in-page capabilities, off by default' },
  'sec.prefs.label': { zh: 'UI 偏好', en: 'PREFS' },
  'sec.prefs.sub': { zh: '只改本机界面，不碰能力', en: 'this device only' },
  'sec.plugin.label': { zh: '插件', en: 'PLUGINS' },
  'sec.plugin.sub': { zh: '一个包的全部贡献整体上下线', en: 'whole pack on / off' },
  'sec.variant.label': { zh: '前端版本', en: 'VARIANTS' },
  'sec.variant.sub': { zh: '这一页用哪一版界面', en: 'which UI implementation' },

  /* ── 卡片通用 ── */
  'card.on': { zh: '已开启', en: 'ON' },
  'card.off': { zh: '已关闭', en: 'OFF' },
  'card.shown': { zh: '已显示', en: 'SHOWN' },
  'card.hidden': { zh: '已隐藏', en: 'HIDDEN' },
  'card.locked': { zh: '锁定', en: 'LOCKED' },
  'card.lockedHint': { zh: '系统页，不可关闭', en: 'system page — always on' },
  'card.defaultOn': { zh: '出厂默认开启', en: 'default on' },
  'card.defaultOff': { zh: '出厂默认关闭', en: 'default off' },
  'card.defaultShown': { zh: '出厂默认显示', en: 'default shown' },
  'card.defaultHidden': { zh: '出厂默认隐藏', en: 'default hidden' },
  'card.goto': { zh: '前往', en: 'Go' },
  'card.gotoBlocked': { zh: '开启后可前往', en: 'enable to open' },
  'card.current': { zh: '当前', en: 'current' },

  /* ── 插件分区 ── */
  'plugin.enabled': { zh: '已启用', en: 'ENABLED' },
  'plugin.disabled': { zh: '已停用', en: 'DISABLED' },
  'plugin.loading': { zh: '读取插件…', en: 'Loading plugins…' },
  'plugin.failed': { zh: '读取插件失败', en: 'Failed to load plugins' },
  'plugin.empty': { zh: '还没有装任何插件', en: 'No plugin installed' },
  'plugin.emptyHint': { zh: '到「设置 → 扩展」装一个 zip 包，它带进来的贡献会在这里一起开关', en: 'Install a zip pack in Settings → Extensions; its contributions toggle here as a whole' },
  'plugin.contrib': { zh: '贡献', en: 'contributes' },
  'plugin.goExtensions': { zh: '去扩展页', en: 'Open Extensions' },
  'plugin.on': { zh: '已启用「{name}」，它的贡献即时上线', en: '“{name}” enabled — its contributions are live' },
  'plugin.off': { zh: '已停用「{name}」，它带进来的贡献已按来源回滚', en: '“{name}” disabled — its contributions rolled back by source' },
  'plugin.delete': { zh: '删除', en: 'Delete' },
  'plugin.deleteTitle': { zh: '删除插件', en: 'Delete plugin' },
  'plugin.deleteMessage': { zh: '确定删除「{name}」吗？这个包带进来的生成源、技能、主题等会一并回滚，同名的自建内容不会动。', en: 'Delete “{name}”? Contributions it brought in (providers, skills, themes, and the rest) are rolled back. Standalone items with the same name are left alone.' },
  'plugin.deleteConfirmBtn': { zh: '确认删除', en: 'Delete' },
  'plugin.deleteCancel': { zh: '取消', en: 'Cancel' },
  'plugin.deleted': { zh: '已删除「{name}」', en: 'Deleted “{name}”' },
  'plugin.deleteFailed': { zh: '删除失败', en: 'Delete failed' },

  /* ── 前端版本分区 ── */
  'variant.hint': { zh: '上面四类管「存不存在」，这里管「用哪一版」——切版本不改后端能力、不改接口准入，只换这一页的渲染实现。当前实现登记为保底版本（默认激活），重构新版以占位条目登记，用来验证「切过去 → 即时生效 → 切回来」。', en: 'The four families above control existence; this one controls form. Switching changes neither backend capability nor API admission — only the page implementation. The current build is registered as the fallback version (active by default); the refactor registers a placeholder so the switch-back path is verifiable today.' },
  'variant.of': { zh: '版本', en: 'variant' },

  /* ── 设置台动作 toast ── */
  'toast.pageOn': { zh: '已开启「{label}」，左侧栏入口已出现', en: '“{label}” enabled — sidebar entry is back' },
  'toast.pageOff': { zh: '已关闭「{label}」，入口已隐藏且对应接口返回 404', en: '“{label}” disabled — entry hidden, its APIs return 404' },
  'toast.featureOn': { zh: '已开启「{label}」，该能力即时生效', en: '“{label}” enabled — applied instantly' },
  'toast.featureOff': { zh: '已关闭「{label}」，相关能力已停用', en: '“{label}” disabled' },
  'toast.prefOn': { zh: '已开启「{label}」，界面元素已显示', en: '“{label}” enabled — element shown' },
  'toast.prefOff': { zh: '已关闭「{label}」，界面元素已隐藏', en: '“{label}” disabled — element hidden' },
  'toast.toggleFailed': { zh: '切换失败', en: 'Toggle failed' },
  'toast.needProject': { zh: '请先在项目看板创建或打开项目', en: 'Create or open a project first' },

  /* ── 版本切换 toast ── */
  'toast.variantSwitched': { zh: '「{page}」已切到「{v}」，界面即时生效', en: '“{page}” switched to “{v}” — applied instantly' },
  'toast.variantFallback': { zh: '「{page}」已切回保底版本', en: '“{page}” switched back to the fallback build' },
  'toast.variantUnavailable': { zh: '该页「{v}」版本已不可用，已回落保底版本', en: 'Variant “{v}” is unavailable — fell back to the fallback build' },

  /* ── 注册表视图 / 诊断面板 ── */
  'panel.registry.label': { zh: '注册表视图', en: 'REGISTRY' },
  'panel.diag.label': { zh: '诊断与演练', en: 'DIAGNOSTICS' },
  'registry.col.entry': { zh: '条目', en: 'entry' },
  'registry.col.kind': { zh: 'kind', en: 'kind' },
  'registry.col.host': { zh: 'host', en: 'host' },
  'registry.col.scope': { zh: 'scope', en: 'scope' },
  'registry.col.variant': { zh: '版本', en: 'variant' },
  'registry.col.source': { zh: '来源', en: 'source' },
  'registry.col.state': { zh: '状态', en: 'state' },
  'registry.lockedList': { zh: '锁定壳（最小形态，永不关闭）', en: 'Locked shell (never off)' },
  'registry.stat.total': { zh: '条目', en: 'entries' },
  'registry.stat.locked': { zh: '锁定', en: 'locked' },
  // 口径（审查 L4-3 / D5）：计的是 `source: 'plugin:*'` 的条目，而它涵盖**所有非内置外部贡献**
  //（含 standalone 槽，见 loader 的 sourceOf）—— 所以标签按「外部来源」说，不谎称都是插件
  'registry.stat.plugins': { zh: '外部来源', en: 'from extensions' },
  'state.on': { zh: '生效', en: 'live' },
  'state.locked': { zh: '锁定常驻', en: 'locked' },
  'state.offPage': { zh: '页面开关关', en: 'page switch off' },
  'state.offFeature': { zh: '功能开关关', en: 'feature switch off' },
  'state.offPrefs': { zh: '偏好关', en: 'pref off' },
  'state.variant': { zh: '非激活版本', en: 'inactive variant' },
  'state.loading': { zh: '开关未加载', en: 'switches loading' },
  'diag.pages': { zh: '页面开关', en: 'pages' },
  'diag.features': { zh: '功能开关', en: 'features' },
  'diag.prefs': { zh: 'UI 偏好', en: 'prefs' },
  'diag.variants': { zh: '已改版本', en: 'changed variants' },
  'diag.reset': { zh: '恢复保底版本', en: 'Reset to fallback' },
  'diag.resetDone': { zh: '已清空全部页面版本偏好，回到保底版本', en: 'All variant prefs cleared — back to the fallback version' },
  'diag.refreshExt': { zh: '强制重拉扩展状态', en: 'Force-refresh extensions' },
  'diag.refreshExtTip': { zh: 'SSE 抖动 / 后端刚重启时用（EventSource 会自动重连、退避最长 30 秒且不会放弃；这里用来补上连接中断期间漏掉的变更）：与事件流同一份刷新事件表，一次广播让插件列表、主题、导出器、导演包、画布节点、分镜槽、生成源、自定义节点各自重拉。不覆盖页面与功能开关（它们各有自己的加载路径）。', en: 'For when the SSE stream hiccups (backend restarted, network blip; EventSource reconnects on its own — backoff capped at 30s, it never gives up — this replays what was missed while disconnected): replays the same refresh event table the stream uses, so the plugin list, themes, exporters, director packs, canvas nodes, storyboard slots, providers and custom nodes all re-pull. Page and feature switches are not covered — they have their own load paths.' },
  'diag.refreshExtDone': { zh: '已广播一轮扩展刷新，各宿主正在重拉', en: 'Refresh broadcast — hosts are re-pulling' },
  'diag.disableCurrent': { zh: '演练：外部停用一页', en: 'Drill: disable a page externally' },
  'diag.disableCurrentTip': { zh: '真实调用后端把「{label}」关掉（模拟别的窗口 / 机器把它关了）：侧栏入口消失、对应接口 404；回到上面「页面开关」分区即可再打开。设置台本身是锁定页，不参与演练。', en: 'Really disables “{label}” via the backend — as if another window did it: its sidebar entry disappears and its APIs return 404. Re-enable it in the PAGES section above. The console itself is locked and never a target.' },
  'diag.confirmTitle': { zh: '演练：外部停用一页', en: 'Drill: disable a page' },
  'diag.confirmBody': { zh: '会真实关闭「{label}」这一页（后端对应接口随之为 404）。要在一个窗口里制造「页面被外部关掉」的场景，这是唯一真实的做法。', en: 'This really turns off “{label}” (its backend APIs return 404). It is the only honest way to reproduce an externally-closed page.' },
  'diag.drillDone': { zh: '已停用「{label}」——侧栏入口应已消失', en: '“{label}” disabled — its sidebar entry should be gone' },
  'diag.currentIs': { zh: '当前页', en: 'current page' },
  'diag.none': { zh: '（无）', en: '(none)' },
  'diag.registryCount': { zh: '注册表条目', en: 'registry entries' },
  'diag.noCurrent': { zh: '当前没有已开启的功能页可演练（只剩设置台）', en: 'No enabled page left to drill (only the console remains)' },
  'diag.inject': { zh: '故障注入：注册一条会抛错的条目', en: 'Inject a crashing entry' },
  'diag.injectRemove': { zh: '移除故障注入', en: 'Remove injected entry' },
  'diag.injectTip': { zh: '仅开发模式可用：往本面板注册一条 render 抛错的条目，验证「只有该条显示占位、其它不受影响、开关不被自动关闭」', en: 'Dev only: registers an entry whose render throws, to verify per-entry isolation' },
  'diag.injected': { zh: '已注入故障条目（看下面这条红色占位）', en: 'Crashing entry injected (see the red block below)' },
  'diag.injectRemoved': { zh: '已移除故障注入', en: 'Injected entry removed' },

  /* ── 标注模式 ── */
  'annot.legend': { zh: '标注模式', en: 'MARKERS' },
  'annot.locked': { zh: '锁定：关不掉', en: 'locked: cannot be turned off' },
  'annot.pluggable': { zh: '可插拔：受注册表管理', en: 'pluggable: registry-managed' },
  'annot.plugin': { zh: '插件贡献：跟插件上下线', en: 'plugin: follows the pack' },
  'annot.hint': { zh: '在「UI 偏好」里关掉即退出标注', en: 'Turn it off in PREFS to exit' },

  /* ── 空态自救页 ── */
  'empty.title': { zh: '当前没有开启任何功能页', en: 'No page is enabled' },
  'empty.desc': { zh: '所有功能页都处于关闭状态，界面暂时无页可进。到「设置 → 功能开关」打开需要的页面即可继续。', en: 'Every page is switched off, so there is nowhere to go. Open the ones you need in Settings → Switchboard.' },
  'empty.disabled': { zh: '已关闭的页面', en: 'Disabled pages' },
  'empty.cta': { zh: '去设置 → 功能开关', en: 'Open Settings → Switchboard' },
  'empty.error': { zh: '读取功能页开关失败：', en: 'Failed to read page switches: ' },

  /* ── 最小形态锁定壳 ── */
  'shell.loading': { zh: '正在加载功能页…', en: 'Loading pages…' },
  'shell.restoring': { zh: '正在恢复项目…', en: 'Restoring project…' },
  'shell.mcpFailed': { zh: '⚠️ MCP 服务连接失败: {msg}（请确认后端已启动）', en: '⚠️ MCP tools failed to connect: {msg} (is the backend running?)' },

  /* ── 通用 ── */
  'common.close': { zh: '关闭', en: 'Close' },
  'common.retry': { zh: '重试', en: 'Retry' },
  'common.none': { zh: '没有可切换项', en: 'Nothing to switch' },
  'common.readFailed': { zh: '读取失败：', en: 'Load failed: ' },
  'common.storageNote': { zh: '存储：', en: 'stored in ' },
  'common.instant': { zh: '（改完即时生效，无需重启）', en: ' (applies instantly)' },
  'common.thisDevice': { zh: '本机 localStorage（只作用当前设备）', en: 'this device (localStorage)' },
} satisfies Record<string, Pair>;

export type UiTextKey = keyof typeof UI_TEXT;

const interpolate = (s: string, vars?: Record<string, string | number>): string => {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
};

/** 当前语言的取词函数（订阅 `ui_lang`，切语言即时重渲染） */
export function useT(): (key: UiTextKey, vars?: Record<string, string | number>) => string {
  const lang = useUiPrefsStore((s) => s.lang);
  return useCallback(
    (key: UiTextKey, vars?: Record<string, string | number>) => {
      const pair = UI_TEXT[key] as Pair | undefined;
      if (!pair) return interpolate(String(key), vars);
      return interpolate(lang === 'en' ? pair.en : pair.zh, vars);
    },
    [lang],
  );
}


