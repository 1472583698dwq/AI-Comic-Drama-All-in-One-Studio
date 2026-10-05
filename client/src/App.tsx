import React, { useState, useEffect, Suspense } from 'react';
import { Header } from './components/navbar/Header';
import { Sidebar } from './components/navbar/Sidebar';
import { ShotInspector } from './components/storyboard/ShotInspector';
import { Director3DStage } from './components/director3d/Director3DStage';
import { MultiTrackTimeline } from './components/timeline/MultiTrackTimeline';
import { CharacterStudio } from './components/character/CharacterStudio';
import { AssetLibrary } from './components/asset/AssetLibrary';
import { MobileCardFlow } from './components/mobile/MobileCardFlow';
import { AgentChatDrawer } from './components/agent/AgentChatDrawer';
import { ScriptImportView } from './views/ScriptImportView';
import { ExportModal } from './components/export/ExportModal';
import { McpToolsModal } from './components/mcp/McpToolsModal';
import { SkillStudioModal } from './components/skills/SkillStudioModal';
import { SetupView } from './views/setup/SetupView';
import { ProjectDashboard } from './views/ProjectDashboard';
import { HomeView } from './views/HomeView';
import { AgentModeView } from './views/AgentModeView';
import { NoPageEnabled } from './components/ui/NoPageEnabled';
import { usePageStore, resolveTab } from './stores/usePageStore';
import { Loader2 } from 'lucide-react';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { ProviderManagerModal } from './components/provider/ProviderManagerModal';
import { ProviderCreateModal, CreateTab, CreateKind } from './components/provider/ProviderCreateModal';
import { WorkflowImportModal } from './components/workflow/WorkflowImportModal';
import { WorkflowInspectorModal } from './components/workflow/WorkflowInspectorModal';
import { GlobalAiPolish } from './components/ui/GlobalAiPolish';
import { GlobalDialogContainer } from './components/ui/GlobalDialogContainer';
import { FirstRunWizard } from './components/onboarding/FirstRunWizard';
import { ContextTipCard } from './components/onboarding/ContextTipCard';
import { installGlobalDialogPatch, toast } from './stores/useDialogStore';
/**
 * 懒加载视图 + 构建更新自愈：
 * 旧窗口在构建更新后请求已被替换的分片会 404，React.lazy 直接抛错 → 整树卸载 = 黑屏。
 * 这里捕获加载失败并整页刷新一次（拿到新 index.html），刷新后再失败才交给 ErrorBoundary 显示红框。
 */
const lazyView = (loader: () => Promise<any>) =>
  React.lazy(() =>
    loader().catch((err) => {
      const KEY = 'studio_chunk_reload_once';
      if (!sessionStorage.getItem(KEY)) {
        sessionStorage.setItem(KEY, '1');
        try { location.reload(); } catch {}
        return new Promise<any>(() => {}); // 挂起，等待刷新
      }
      throw err;
    })
  );

const CreativeCanvas = lazyView(()=> import('./components/canvas/CreativeCanvas').then(m=> ({default: m.CreativeCanvas})));
/** 成片工作室：一键成片的独立页面（Agent 自主编排；替代原弹窗） */
const OneKeyStudioView = lazyView(()=> import('./views/OneKeyStudioView').then(m=> ({default: m.OneKeyStudioView})));
import { useProjectStore } from './stores/useProjectStore';
import { useMcpStore } from './stores/useMcpStore';

/**
 * 功能页 host 键 → 组件。键取自后端 `/api/v1/pages` 的 host 字段（契约冻结），
 * 大组件（画布）继续走 lazyView，主包只装首页 / 看板 / 设置这类秒开页。
 */
const PAGE_HOSTS: Record<string, React.ComponentType<any>> = {
  home: HomeView,
  projects: ProjectDashboard,
  canvas: CreativeCanvas,
  agent: AgentModeView,
  assets: AssetLibrary,
  characters: CharacterStudio,
  onekey: OneKeyStudioView,
  studio: ShotInspector,
  timeline: ShotInspector,
  director3d: Director3DStage,
  config: SetupView,
};

/** 共用 ShotInspector 的三个「片场」host：桌面模式下其下方固定渲染多轨时间线（结构同新基线） */
const STAGE_HOSTS = ['studio', 'timeline', 'director3d'];

/** 无项目时仍可停留的全局页（其余都是项目内部页，需要先有项目 —— 既有准入规则） */
const GLOBAL_TABS = ['home', 'projects', 'config'];

/** 历史页签的展示名（归一提示用；查不到的页签不提示，免得给用户念一串 id） */
const LEGACY_TAB_LABEL: Record<string, string> = { mcp: 'MCP 工具' };

export function App() {
  const { project, activeTab, platformMode, apiError, clearApiError, isLoading, activeProjectId } = useProjectStore();
  const { fetchTools } = useMcpStore();
  // 功能页运行时开关：页签准入的唯一依据（后端 /api/v1/pages）
  const pagesLoaded = usePageStore((s) => s.loaded);
  const pagesItems = usePageStore((s) => s.items);
  const pagesValues = usePageStore((s) => s.values);

  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isMcpOpen, setIsMcpOpen] = useState(false);
  const [isSkillsOpen, setIsSkillsOpen] = useState(false);
  const [isProviderOpen, setIsProviderOpen] = useState(false);
  const [providerEdit, setProviderEdit] = useState<any>(null);
  // 新建自定义生成源（全局单例弹窗：管理弹窗 / 画布节点 / 扩展页 / Provider 节点共用）
  const [createState, setCreateState] = useState<{ open: boolean; tab: CreateTab; kind: CreateKind; select: boolean; source: string }>({
    open: false, tab: 'doc', kind: 'image', select: false, source: '',
  });
  // ComfyUI 工作流导入 / 槽位配置（全局）：修复「导入 ComfyUI 工作流」死入口
  const [wfImportOpen, setWfImportOpen] = useState(false);
  const [wfInspectId, setWfInspectId] = useState('');
  const [mcpError, setMcpError] = useState<string | null>(null);

  useEffect(() => {
    // 启动成功即清掉分片自愈标记，让下一次构建更新仍能自动刷新一次
    try { sessionStorage.removeItem('studio_chunk_reload_once'); } catch {}
    installGlobalDialogPatch();
    fetchTools().catch((e: any) => setMcpError(e?.message || 'MCP 服务连接失败'));
    // 启动：先拉功能页开关（渲染准入依据），再恢复项目；没有项目则落到首页
    usePageStore.getState().load().catch(() => {});
    useProjectStore.getState().ensureActiveProject().catch(() => {});
    const h = (e: any) => { setProviderEdit(e?.detail?.provider || null); setIsProviderOpen(true); };
    // 新建自定义生成源（统一创建弹窗）：detail = { tab?: 'doc'|'code'|'comfy', kind?, select?, source? }
    const onOpenProviderCreate = (e: any) => {
      const d = e?.detail || {};
      setCreateState({
        open: true,
        tab: (d.tab as CreateTab) || 'doc',
        kind: (d.kind as CreateKind) || 'image',
        select: !!d.select,
        source: String(d.source || ''),
      });
    };
    // ComfyUI 工作流导入 / 槽位配置（全局，任何页面都能开）
    const onOpenWorkflowImport = () => setWfImportOpen(true);
    const onOpenWorkflowInspector = (e: any) => {
      const id = String(e?.detail?.workflowId || '');
      if (id) setWfInspectId(id);
    };
    // 画布底部栏 / 导出节点派发的全局意图事件，此前无人监听导致按钮点了没反应
    const onOpenExport = () => setIsExportOpen(true);
    // 设置→扩展页里的入口：技能工坊 / MCP 工具（原先在侧边栏）
    const onOpenSkillStudio = () => setIsSkillsOpen(true);
    const onOpenMcpTools = () => setIsMcpOpen(true);
    const onOpenAssetLibrary = () => {
      const st = useProjectStore.getState();
      if (!st.project) { toast.info('请先在项目看板创建或打开项目'); return; }
      st.setWorkspace('production');
      st.setActiveTab('assets');
    };
    // 插件主题包（themes 扩展点）：启动同步 + 插件启停后热刷新
    const syncThemes = () => { import('./services/themeSpecs').then((m) => m.syncPluginThemes().catch(() => {})).catch(() => {}); };
    syncThemes();
    window.addEventListener('open-provider-manager', h as any);
    window.addEventListener('open-provider-create', onOpenProviderCreate as any);
    window.addEventListener('open-workflow-import', onOpenWorkflowImport as any);
    window.addEventListener('open-workflow-inspector', onOpenWorkflowInspector as any);
    window.addEventListener('open-export-modal', onOpenExport as any);
    window.addEventListener('open-asset-library', onOpenAssetLibrary as any);
    window.addEventListener('theme-list-refresh', syncThemes as any);
    window.addEventListener('open-skill-studio', onOpenSkillStudio as any);
    window.addEventListener('open-mcp-tools', onOpenMcpTools as any);
    return () => {
      window.removeEventListener('open-provider-manager', h as any);
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
    if (!project && !GLOBAL_TABS.includes(activeTab)) {
      useProjectStore.getState().setActiveTab((resolveTab('home') || 'projects') as any);
    }
  }, [project, activeTab, isLoading, pagesLoaded]);

  /** 启动恢复中（有缓存项目正在拉取）：先占位，别先闪一眼首页/看板再跳 */
  const restoring = isLoading && !project && !!activeProjectId;

  /**
   * 归一后的页签（渲染的唯一依据）：
   * - 未加载完成 / 启动恢复中 → null，渲染轻量加载占位（绝不闪出未开启页）
   * - 请求页可用 → 就是它；已关闭 / 未知 / 历史页签 → 第一个可用页
   * - 一个可用页都没有 → null，渲染空态页
   * 无项目时再叠一层既有准入规则：只能落在全局页。
   *
   * 每次渲染现算（几次数组成员判断，成本可忽略）：resolveTab 读的是 store 快照，
   * 用 memo 反而要靠「假装存在的依赖」才能重算 —— 直接算最不容易出错。
   */
  const resolvedTab: string | null = (() => {
    if (!pagesLoaded || restoring) return null;
    const hit = resolveTab(activeTab);
    if (!project && hit && !GLOBAL_TABS.includes(hit)) {
      for (const g of GLOBAL_TABS) {
        const r = resolveTab(g);
        if (r && GLOBAL_TABS.includes(r)) return r;
      }
      return null;
    }
    return hit;
  })();

  // 归一发生（含「开关一变」）→ 切到可用页并解释原因。
  // 这里读 pagesValues 既是提示文案的依据，也是「页面开关变化必须触发重渲染」的订阅来源
  // （resolvedTab 是渲染期现算的，没有这个订阅 App 就感知不到开关变化）。
  useEffect(() => {
    if (!pagesLoaded || !resolvedTab || resolvedTab === activeTab) return;
    const requested = pagesItems.find((i) => i.id === activeTab);
    const fromLabel = requested && pagesValues[requested.id] !== true
      ? requested.label
      : LEGACY_TAB_LABEL[activeTab];
    const toLabel = pagesItems.find((i) => i.id === resolvedTab)?.label || resolvedTab;
    if (fromLabel) toast.info(`${fromLabel} 已关闭，已为你切到 ${toLabel}`);
    useProjectStore.getState().setActiveTab(resolvedTab as any);
  }, [pagesLoaded, resolvedTab, activeTab, pagesItems, pagesValues]);

  /** 归一页签 → host 键（后端允许 host 与 id 不同）→ 组件 */
  const renderTab = (tab: string) => {
    const host = pagesItems.find((i) => i.id === tab)?.host || tab;

    // 片场三页（分镜台 / 多轨剪辑 / 3D 片场）：桌面模式下共用 ShotInspector + 底部固定多轨时间线
    if (STAGE_HOSTS.includes(host)) {
      const Stage = PAGE_HOSTS[host];
      return platformMode === 'desktop' ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 flex overflow-hidden">
            <Stage />
          </div>
          <MultiTrackTimeline />
        </div>
      ) : (
        <MobileCardFlow onOpenExport={() => setIsExportOpen(true)} />
      );
    }

    const Host = PAGE_HOSTS[host] || ProjectDashboard;
    if (host === 'canvas') {
      return (
        <ErrorBoundary name="创意画布">
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-gray-500">画布加载中…</div>}>
            <Host />
          </Suspense>
        </ErrorBoundary>
      );
    }
    if (host === 'agent') return <ErrorBoundary name="Agent模式页"><Host /></ErrorBoundary>;
    if (host === 'config') return <ErrorBoundary name="设置中心"><Host /></ErrorBoundary>;
    if (host === 'home') return <ErrorBoundary name="首页"><Host /></ErrorBoundary>;
    if (host === 'onekey') {
      return (
        <ErrorBoundary name="成片工作室">
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-gray-500">成片工作室加载中…</div>}>
            <Host />
          </Suspense>
        </ErrorBoundary>
      );
    }
    return <Host />;
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-gray-100 overflow-hidden">
      {/* 1. Universal Top Navigation Header */}
      <Header
        onOpenImport={() => setIsImportOpen(true)}
        onOpenExport={() => setIsExportOpen(true)}
        onOpenMcp={() => setIsMcpOpen(true)}
        onOpenSkills={() => setIsSkillsOpen(true)}
        onOpenProvider={() => setIsProviderOpen(true)}
      />

      {/* Api Error Banner */}
      {apiError && (
        <div className="mx-4 mt-2 px-4 py-2 rounded-lg bg-red-500/15 border border-red-500/40 text-xs text-red-300 flex items-center justify-between">
          <span>⚠️ {apiError}</span>
          <button onClick={clearApiError} className="ml-3 px-2 py-0.5 rounded bg-red-500/30 hover:bg-red-500/50 text-white">关闭</button>
        </div>
      )}
      {mcpError && (
        <div className="mx-4 mt-2 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-center justify-between">
          <span>⚠️ MCP 服务连接失败: {mcpError}（请确认后端已启动）</span>
          <button onClick={() => setMcpError(null)} className="ml-3 px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/40">关闭</button>
        </div>
      )}

      {/* 2. 左侧主导航 + 内容区（设置页为全屏，自带子导航） */}
      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          onOpenMcp={() => setIsMcpOpen(true)}
          onOpenSkills={() => setIsSkillsOpen(true)}
          onOpenProvider={() => setIsProviderOpen(true)}
        />
        <main className="flex-1 flex flex-col overflow-hidden relative min-w-0">
          {/* 兜底边界：任何视图运行时崩溃都显示可读错误 + 重试，而不是黑屏/白屏。
              key 绑定项目 id：切换项目即整页重建，画布/素材库等「挂载时拉数据」的视图才会加载新项目内容，
              不会停留在上一个项目（同一页签下切项目不会自然卸载组件）。 */}
          <ErrorBoundary name="当前页面" key={project?.id || 'no-project'}>
          {!pagesLoaded || restoring ? (
            // 加载占位：功能页开关到手前不渲染任何页，避免闪出「已关闭」的页
            <div className="flex-1 flex items-center justify-center gap-2 text-xs text-gray-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {restoring ? '正在恢复项目…' : '正在加载功能页…'}
            </div>
          ) : resolvedTab ? (
            renderTab(resolvedTab)
          ) : (
            <NoPageEnabled />
          )}
          </ErrorBoundary>
          {/* 上下文轻引导卡：每页首进只出现 1 张，读过不再出现（设置 → 系统 可重置） */}
          {project && resolvedTab === 'canvas' && (
            <ContextTipCard
              storageKey="canvas_first"
              title="画布这样玩"
              desc="按住节点右侧圆点拖到下一个节点即连线；选中生图 / 视频 / 配音节点，底部会弹出它的 Agent 控制台，用一句大白话描述你要什么即可。"
            />
          )}
          {project && platformMode === 'desktop' && (resolvedTab === 'studio' || resolvedTab === 'timeline') && (
            <ContextTipCard
              storageKey="studio_first"
              title="分镜台这样用"
              desc="先用顶栏「导入」粘贴小说章节，AI 会自动拆分镜；选中镜头后可在检查器里生成首帧 / 视频 / 配音，底部时间线控制整体节奏。"
            />
          )}
        </main>
      </div>

      {/* 3. 悬浮导演 Agent（仅当存在有效项目、且当前页没有自己的 Agent 界面时启用）
          画布页有专属的右侧 Agent 侧栏（CanvasAgentSidebar）、「AI 导演」页本身就是全屏
          Agent 主界面，两者都与本抽屉共用同一份会话；此处用**归一后的页签**做闸门，
          避免同一份会话在页面上出现两个功能重复的入口。
          key 绑定项目 id：切换项目即重建会话侧栏，避免串到上一个项目的会话。 */}
      {project && resolvedTab && resolvedTab !== 'canvas' && resolvedTab !== 'agent' && <AgentChatDrawer key={project.id} />}

      {/* 3.1 Global AI Polish (covers all textareas) */}
      <GlobalAiPolish />

      {/* 4. Global Modals */}
      <ScriptImportView
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
      />

      <ExportModal
        isOpen={isExportOpen}
        onClose={() => setIsExportOpen(false)}
      />

      <McpToolsModal
        isOpen={isMcpOpen}
        onClose={() => setIsMcpOpen(false)}
      />

      <SkillStudioModal
        isOpen={isSkillsOpen}
        onClose={() => setIsSkillsOpen(false)}
      />

      <ProviderManagerModal
        isOpen={isProviderOpen}
        editProvider={providerEdit}
        onClose={() => { setIsProviderOpen(false); setProviderEdit(null); }}
      />

      {/* 新建自定义生成源（统一创建弹窗）：成功后刷新列表并广播 provider-created（画布可自动选中新源） */}
      <ProviderCreateModal
        isOpen={createState.open}
        defaultTab={createState.tab}
        defaultKind={createState.kind}
        selectOnCreate={createState.select}
        onClose={() => setCreateState((s) => ({ ...s, open: false }))}
        onCreated={(provider, opts) => {
          window.dispatchEvent(new Event('provider-list-refresh'));
          window.dispatchEvent(new CustomEvent('provider-created', { detail: { provider, select: opts.select, source: createState.source } }));
        }}
      />

      {/* ComfyUI 工作流导入 → 槽位配置（保存即派生生成源） */}
      <WorkflowImportModal
        isOpen={wfImportOpen}
        onClose={() => setWfImportOpen(false)}
        onImported={(wfId) => {
          setWfImportOpen(false);
          if (wfId) setWfInspectId(wfId);
        }}
      />
      {wfInspectId && (
        <WorkflowInspectorModal
          workflowId={wfInspectId}
          isOpen={!!wfInspectId}
          onClose={() => setWfInspectId('')}
          onSaved={() => { setWfInspectId(''); window.dispatchEvent(new Event('provider-list-refresh')); }}
        />
      )}

      {/* Modern Global Toast / Confirm / Prompt Dialogs */}
      <GlobalDialogContainer />

      {/* 安装向导：首次启动且未配置能力时自动弹出（可跳过）；设置 → 系统 可随时重开 */}
      <FirstRunWizard />
    </div>
  );
}

export default App;
