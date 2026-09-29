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
import { AgentModeView } from './views/AgentModeView';
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
import { useProjectStore } from './stores/useProjectStore';
import { useMcpStore } from './stores/useMcpStore';

export function App() {
  const { project, activeTab, platformMode, apiError, clearApiError } = useProjectStore();
  const { fetchTools } = useMcpStore();

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
    useProjectStore.getState().loadActiveProject();
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

  // 严格 UI 准入拦截：未选择或创建项目时，禁止停留在任何项目内部功能页，自动重定向至项目看板
  useEffect(() => {
    if (!project && activeTab !== 'projects' && activeTab !== 'config') {
      useProjectStore.getState().setActiveTab('projects');
    }
  }, [project, activeTab]);

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
          {/* 兜底边界：任何视图运行时崩溃都显示可读错误 + 重试，而不是黑屏/白屏 */}
          <ErrorBoundary name="当前页面">
          {activeTab === 'config' ? (
            <ErrorBoundary name="设置中心">
              <SetupView />
            </ErrorBoundary>
          ) : (!project || activeTab === 'projects') ? (
            <ProjectDashboard />
          ) : activeTab === 'canvas' ? (
            <ErrorBoundary name="创意画布">
              <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-gray-500">画布加载中…</div>}>
                <CreativeCanvas />
              </Suspense>
            </ErrorBoundary>
          ) : activeTab === 'agent' ? (
            <ErrorBoundary name="Agent模式页">
              <AgentModeView />
            </ErrorBoundary>
          ) : activeTab === 'characters' ? (
            <CharacterStudio />
          ) : activeTab === 'assets' ? (
            <AssetLibrary />
          ) : platformMode === 'desktop' ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 flex overflow-hidden">
                {(activeTab === 'studio' || activeTab === 'timeline') && <ShotInspector />}
                {activeTab === 'director3d' && <Director3DStage />}
              </div>
              <MultiTrackTimeline />
            </div>
          ) : (
            <MobileCardFlow onOpenExport={() => setIsExportOpen(true)} />
          )}
          </ErrorBoundary>
          {/* 上下文轻引导卡：每页首进只出现 1 张，读过不再出现（设置 → 系统 可重置） */}
          {project && activeTab === 'canvas' && (
            <ContextTipCard
              storageKey="canvas_first"
              title="画布这样玩"
              desc="按住节点右侧圆点拖到下一个节点即连线；选中生图 / 视频 / 配音节点，底部会弹出它的 Agent 控制台，用一句大白话描述你要什么即可。"
            />
          )}
          {project && platformMode === 'desktop' && (activeTab === 'studio' || activeTab === 'timeline') && (
            <ContextTipCard
              storageKey="studio_first"
              title="分镜台这样用"
              desc="先用顶栏「导入」粘贴小说章节，AI 会自动拆分镜；选中镜头后可在检查器里生成首帧 / 视频 / 配音，底部时间线控制整体节奏。"
            />
          )}
        </main>
      </div>

      {/* 3. Floating Multi-Modal Director Agent (仅当存在有效项目时启用) */}
      {project && <AgentChatDrawer />}

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
