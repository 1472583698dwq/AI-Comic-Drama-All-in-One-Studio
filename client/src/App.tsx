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
import { GlobalAiPolish } from './components/ui/GlobalAiPolish';
import { GlobalDialogContainer } from './components/ui/GlobalDialogContainer';
import { FirstRunWizard } from './components/onboarding/FirstRunWizard';
import { installGlobalDialogPatch, toast } from './stores/useDialogStore';
const CreativeCanvas = React.lazy(()=> import('./components/canvas/CreativeCanvas').then(m=> ({default: m.CreativeCanvas})));
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
  const [providerEditId, setProviderEditId] = useState('');
  const [mcpError, setMcpError] = useState<string | null>(null);

  useEffect(() => {
    installGlobalDialogPatch();
    fetchTools().catch((e: any) => setMcpError(e?.message || 'MCP 服务连接失败'));
    useProjectStore.getState().loadActiveProject();
    const h = (e: any) => { setProviderEditId(e?.detail?.providerId || ''); setIsProviderOpen(true); };
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
    window.addEventListener('open-export-modal', onOpenExport as any);
    window.addEventListener('open-asset-library', onOpenAssetLibrary as any);
    window.addEventListener('theme-list-refresh', syncThemes as any);
    window.addEventListener('open-skill-studio', onOpenSkillStudio as any);
    window.addEventListener('open-mcp-tools', onOpenMcpTools as any);
    return () => {
      window.removeEventListener('open-provider-manager', h as any);
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
          {activeTab === 'config' ? (
            <ErrorBoundary name="设置中心">
              <SetupView />
            </ErrorBoundary>
          ) : (!project || activeTab === 'projects') ? (
            <ProjectDashboard />
          ) : activeTab === 'canvas' ? (
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-gray-500">画布加载中…</div>}>
              <CreativeCanvas />
            </Suspense>
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
        editProviderId={providerEditId}
        onClose={() => { setIsProviderOpen(false); setProviderEditId(''); }}
      />

      {/* Modern Global Toast / Confirm / Prompt Dialogs */}
      <GlobalDialogContainer />

      {/* 首次启动安装向导（未完成引导时自动弹出；可通过事件重新打开） */}
      <FirstRunWizard />
    </div>
  );
}

export default App;
