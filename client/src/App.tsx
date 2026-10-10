import React, { useEffect } from 'react';
import { usePageStore, resolveTab } from './stores/usePageStore';
import { isGlobalPage, legacyTabLabel } from './ui-registry/pageTabs';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { installGlobalDialogPatch, toast } from './stores/useDialogStore';
// 条目注册（副作用导入）：页面 / 弹窗 / 锁定壳 / 设置台面板 / 标注图例 / 侧栏块 / 呈现型面板 / 工具动作
import './ui-registry/entries/pages';
import './ui-registry/entries/modals';
import './ui-registry/entries/shell';
import './ui-registry/entries/consolePanels';
import './ui-registry/entries/annotate';
import './ui-registry/entries/sidebar';
import './ui-registry/entries/panels';
import './ui-registry/entries/toolbar';
import { UISlot } from './ui-registry/UISlot';
import { useResolvedTab } from './ui-registry/useResolvedTab';
import { isLockedPageId } from './ui-registry/pageLocks';
import { UnregisteredPagePlaceholder } from './ui-registry/entries/placeholders';
import {
  APP_HOST, DEFAULT_VARIANT, MAIN_TIPS_HOST, markAttrs, pageHost,
  SHELL_HOST_EMPTY, SHELL_HOST_LOADING, SHELL_HOST_SIDEBAR, SHELL_HOST_TOP,
} from './ui-registry/types';
import { useUiPrefsStore } from './stores/useUiPrefsStore';
import { useModalIntentsStore } from './ui-registry/modalIntents';
import { useShellStatusStore } from './ui-registry/shellStatus';
import { startExtensionsStream } from './services/extensionsStream';
import { useProjectStore } from './stores/useProjectStore';
import { useFeatureStore } from './stores/useFeatureStore';
import { useMcpStore } from './stores/useMcpStore';

/** 无项目时仍可停留的全局页（其余都是项目内部页）与历史页签展示名，见 stores/usePageStore */
export function App() {
  // 注意：apiError / mcpError 两条横幅已搬进锁定壳条目（shell.banner.*），App 不再持有它们；
  // platformMode / 引导卡条件也随 ContextTipCard 一起搬进了 `tip.*` 条目
  const { project, activeTab, isLoading, activeProjectId } = useProjectStore();
  const { fetchTools } = useMcpStore();
  // 功能页运行时开关：页签准入的唯一依据（后端 /api/v1/pages）
  const pagesLoaded = usePageStore((s) => s.loaded);
  const pagesItems = usePageStore((s) => s.items);
  const pagesValues = usePageStore((s) => s.values);
  // 页面版本偏好（page_variant.<pageId>）：标注模式要显示「当前页跑的是哪个版本」
  const variants = useUiPrefsStore((s) => s.variants);

  useEffect(() => {
    // 启动成功即清掉分片自愈标记，让下一次构建更新仍能自动刷新一次
    try { sessionStorage.removeItem('studio_chunk_reload_once'); } catch {}
    installGlobalDialogPatch();
    // 壳级状态：MCP 拉取失败的文案搬到了 shellStatus store（顶栏壳的横幅条目读它，
    // 因为横幅已挪进注册表槽位、读不到 App 的局部 state）
    fetchTools().catch((e: any) => useShellStatusStore.getState().setMcpError(e?.message || 'MCP 服务连接失败'));
    // 启动：先拉功能页开关（渲染准入依据）与功能开关（页内能力准入，画布会消费），再恢复项目
    usePageStore.getState().load().catch(() => {});
    // 功能开关以前只在打开设置页时才拉（缺口 §2.5-10）；现在画布要按它做页内准入，
    // 必须在启动就拉 —— 语义仍是 fail-closed（拉不到 = 关），与 useFeatureStore 的既定口径一致
    useFeatureStore.getState().load().catch(() => {});
    useProjectStore.getState().ensureActiveProject().catch(() => {});
    // 扩展 / 插件变更事件流（SSE）：后端一变就重播各宿主的 *-list-refresh（Phase 4 热插拔闭环）
    const stopExtensionsStream = startExtensionsStream();
    // 全局弹窗意图：事件名 / 触发时机 / detail 参数与改造前完全一致，只是改写 store（弹窗在注册表槽里）
    const intents = () => useModalIntentsStore.getState();
    const onOpenProviderManager = (e: any) => intents().openProviderManager(e?.detail?.provider || null);
    // 新建自定义生成源（统一创建弹窗）：detail = { tab?: 'doc'|'code'|'comfy', kind?, select?, source? }
    const onOpenProviderCreate = (e: any) => intents().openProviderCreate(e?.detail || {});
    // ComfyUI 工作流导入 / 槽位配置（全局，任何页面都能开）
    const onOpenWorkflowImport = () => intents().openWorkflowImport();
    // 原逻辑：id 为空则忽略（store 的 openWorkflowInspector 已做空值保护，语义一致）
    const onOpenWorkflowInspector = (e: any) => intents().openWorkflowInspector(String(e?.detail?.workflowId || ''));
    // 画布底部栏 / 导出节点派发的全局意图事件，此前无人监听导致按钮点了没反应
    const onOpenExport = () => intents().openExport();
    // 设置→扩展页里的入口：技能工坊 / MCP 工具（原先在侧边栏）
    const onOpenSkillStudio = () => intents().openSkills();
    const onOpenMcpTools = () => intents().openMcp();
    const onOpenAssetLibrary = () => {
      const st = useProjectStore.getState();
      if (!st.project) { toast.info('请先在项目看板创建或打开项目'); return; }
      st.setWorkspace('production');
      st.setActiveTab('assets');
    };
    // 插件主题包（themes 扩展点）：启动同步 + 插件启停后热刷新
    const syncThemes = () => { import('./services/themeSpecs').then((m) => m.syncPluginThemes().catch(() => {})).catch(() => {}); };
    syncThemes();
    window.addEventListener('open-provider-manager', onOpenProviderManager as any);
    window.addEventListener('open-provider-create', onOpenProviderCreate as any);
    window.addEventListener('open-workflow-import', onOpenWorkflowImport as any);
    window.addEventListener('open-workflow-inspector', onOpenWorkflowInspector as any);
    window.addEventListener('open-export-modal', onOpenExport as any);
    window.addEventListener('open-asset-library', onOpenAssetLibrary as any);
    window.addEventListener('theme-list-refresh', syncThemes as any);
    window.addEventListener('open-skill-studio', onOpenSkillStudio as any);
    window.addEventListener('open-mcp-tools', onOpenMcpTools as any);
    return () => {
      stopExtensionsStream();
      window.removeEventListener('open-provider-manager', onOpenProviderManager as any);
      window.removeEventListener('open-provider-create', onOpenProviderCreate as any);
      window.removeEventListener('open-workflow-import', onOpenWorkflowImport as any);
      window.removeEventListener('open-workflow-inspector', onOpenWorkflowInspector as any);
      window.removeEventListener('open-export-modal', onOpenExport as any);
      window.removeEventListener('open-asset-library', onOpenAssetLibrary as any);
      window.removeEventListener('theme-list-refresh', syncThemes as any);
      window.removeEventListener('open-skill-studio', onOpenSkillStudio as any);
      window.removeEventListener('open-mcp-tools', onOpenMcpTools as any);
    };
  }, []);

  // 严格 UI 准入拦截：未选择或创建项目时，禁止停留在任何项目内部功能页，自动重定向到一个全局页。
  // 两个跳过条件缺一不可：
  //   isLoading —— 项目恢复中，否则会把缓存的项目内页签冲掉；
  //   !pagesLoaded —— 功能页开关还没拉到，此时 resolvedTab 尚未确定；抢跑会把
  //   「缓存页签 → 回落 + 提示」整条链路吃掉（缓存 studio 且 studio 已关闭时会静默跳走）。
  // 目标页同样走 resolveTab：看板/首页都可能被功能开关关掉，不能硬跳一个不可用页。
  useEffect(() => {
    if (isLoading || !pagesLoaded) return;
    if (!project && !isGlobalPage(activeTab)) {
      useProjectStore.getState().setActiveTab((resolveTab('home') || 'projects') as any);
    }
  }, [project, activeTab, isLoading, pagesLoaded]);

  /** 启动恢复中（有缓存项目正在拉取）：先占位，别先闪一眼首页/看板再跳 */
  const restoring = isLoading && !project && !!activeProjectId;

  /**
   * 归一后的页签（渲染的唯一依据）：**与注册表条目共用同一份实现**（`ui-registry/useResolvedTab`）
   * —— 引导卡 / 悬浮抽屉等条目也用同一口径，否则它们会在开关加载完之前先按缓存的原始 activeTab
   * 挂上、归一后立刻卸载（启动瞬间闪一下，审查 L7）。规则见该模块注释。
   */
  const resolvedTab = useResolvedTab();

  /**
   * 页面槽的挂载点（决定「哪一槽在渲染」）：
   * - 开关未加载完 → 先用**缓存页签**挂槽，槽自己会渲染统一加载占位（设计 §9.2）；
   *   于是「未加载」这件事不再由 App 判断 `pagesLoaded`。
   * - 已加载 → 归一页签；**归一结果为空时不再拿 `activeTab` 去撞运气**（审查 M5）：
   *   归一为空 = 一个可用页都没有（config 不算），这一槽判为「无页可渲染」，
   *   由 App 直接渲染全关空态自救页。为什么不能像改造前那样交给槽的 `fallback`：
   *   两种「空」必须分开 ——
   *     · `resolvedTab === null`：真的没有任何可用页 → 全关空态页（文案：当前没有开启任何功能页）；
   *     · `resolvedTab` 非空但槽内无条目：后端开着、前端却没登记这一页的实现 → 要说出
   *       「是哪一页缺实现」，复用全关空态页会谎报「当前没有开启任何功能页」。
   *   （`resolveTab()` 只按后端 `/pages` 的 id + 开关判定，不认前端实现表，见 stores/usePageStore。）
   */
  const pageSlotId = pagesLoaded ? resolvedTab : activeTab;

  /**
   * 标注模式（清单第 7 条）：页面槽**不能加包裹层**（多一个 flex 子项就会动到 `main` 的布局），
   * 所以把条目标注属性直接展开到 `main` 本身 —— `main` 的盒子恰好就是「当前这一页」的区域。
   * 只在真的渲染某一页时标注：加载态 / 空态各有自己的壳条目自标，不该冒充页面槽。
   * `id` / `locked` 与注册表条目同源（`page.<id>@<variant>` + `pageLocks`），两处说同一件事。
   */
  const pageMark: Record<string, string> = (() => {
    if (!pagesLoaded || !resolvedTab) return {};
    const variant = variants[resolvedTab] || DEFAULT_VARIANT;
    return markAttrs({
      // 用**条目 id 的形状**（`page.<id>@<variant>`，审查 L4-2）：注册表视图里是 `page.home@default`，
      // 标注若只写 `page.home`，两个视图就永远对不上同一件事。
      id: `${pageHost(resolvedTab)}@${variant}`,
      kind: 'page', scope: 'page', source: 'builtin', variant,
      locked: isLockedPageId(resolvedTab),
    });
  })();

  // 归一发生（含「开关一变」）→ 切到可用页并解释原因。
  // 这里读 pagesValues 既是提示文案的依据，也是「页面开关变化必须触发重渲染」的订阅来源
  // （resolvedTab 是渲染期现算的，没有这个订阅 App 就感知不到开关变化）。
  useEffect(() => {
    if (!pagesLoaded || !resolvedTab || resolvedTab === activeTab) return;
    const requested = pagesItems.find((i) => i.id === activeTab);
    const fromLabel = requested && pagesValues[requested.id] !== true
      ? requested.label
      : legacyTabLabel(activeTab);
    const toLabel = pagesItems.find((i) => i.id === resolvedTab)?.label || resolvedTab;
    if (fromLabel) toast.info(`${fromLabel} 已关闭，已为你切到 ${toLabel}`);
    useProjectStore.getState().setActiveTab(resolvedTab as any);
  }, [pagesLoaded, resolvedTab, activeTab, pagesItems, pagesValues]);

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-gray-100 overflow-hidden">
      {/* 1. 最小形态（锁定壳）：顶栏 + 两条启动错误横幅。
          这三条在注册表里是 locked —— 跳过一切开关判断永远渲染（设计 §5.2 第 2/9 条），
          触发点与层叠顺序与改造前逐条一致，只是从 App 的 JSX 搬进了 host=shell.top 的槽位。 */}
      <UISlot host={SHELL_HOST_TOP} />

      {/* 2. 左侧主导航 + 内容区（设置页为全屏，自带子导航） */}
      <div className="flex-1 flex overflow-hidden">
        {/* 侧栏壳（含底部「生成源 / 主题 / 设置 / 收起」工具区）同样是 locked：
            导航项仍按页面开关过滤，但设置这个自救入口永远在（设计 §5.2 第 3 条） */}
        <UISlot host={SHELL_HOST_SIDEBAR} />
        <main className="flex-1 flex flex-col overflow-hidden relative min-w-0" {...pageMark}>
          {/* 兜底边界：任何视图运行时崩溃都显示可读错误 + 重试，而不是黑屏/白屏。
              key 绑定项目 id：切换项目即整页重建，画布/素材库等「挂载时拉数据」的视图才会加载新项目内容，
              不会停留在上一个项目（同一页签下切项目不会自然卸载组件）。 */}
          <ErrorBoundary name="当前页面" key={project?.id || 'no-project'}>
          {restoring ? (
            // 启动恢复中（有缓存项目正在拉取）：App 先占位，别先闪一眼首页/看板再跳
            <UISlot host={SHELL_HOST_LOADING} />
          ) : pageSlotId ? (
            // 页面槽自己负责「开关未加载 → 统一加载占位」；槽内无生效条目时分两种空态
            // （见 pageSlotId 注释）：归一结果非空 → 该页前端未注册的独立兜底；
            // 归一结果为空 → 全关空态自救页（locked 壳，内含去开关面板的路）
            <UISlot
              host={pageHost(pageSlotId)}
              fallback={resolvedTab
                ? <UnregisteredPagePlaceholder pageId={resolvedTab} />
                : <UISlot host={SHELL_HOST_EMPTY} />}
            />
          ) : (
            // 归一结果为空（一个可用页都没有）→ 全关空态自救页
            <UISlot host={SHELL_HOST_EMPTY} />
          )}
          </ErrorBoundary>
          {/* 上下文轻引导卡（Phase 3 起是注册表条目 `tip.canvas-first` / `tip.studio-first`，
              受 UI 偏好 `tip_context` 控制）。挂载点留在 main 内，卡片原有的 `absolute` 定位基准不变。 */}
          <UISlot host={MAIN_TIPS_HOST} />
        </main>
      </div>

      {/* 3. 悬浮导演 Agent（`panel.agent-drawer`）与全局 AI 润色（`panel.ai-polish`）：
          Phase 3 起都是 host='app' 的注册表条目，受各自 UI 偏好控制；
          原来的运行时闸门（有项目 ∧ 非画布 ∧ 非导演页）与 key 绑项目都搬进了条目内部，语义不变。 */}
      <UISlot host={APP_HOST} />
    </div>
  );
}

export default App;
