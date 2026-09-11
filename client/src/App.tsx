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
import { ConfigView } from './views/ConfigView';
import { ProjectDashboard } from './views/ProjectDashboard';
import { AgentModeView } from './views/AgentModeView';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { ProviderManagerModal } from './components/provider/ProviderManagerModal';
import { GlobalAiPolish } from './components/ui/GlobalAiPolish';
import { GlobalDialogContainer } from './components/ui/GlobalDialogContainer';
import { FirstRunWizard } from './components/onboarding/FirstRunWizard';
import { installGlobalDialogPatch } from './stores/useDialogStore';
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
  const [mcpError, setMcpError] = useState<string | null>(null);

  useEffect(() => {
    installGlobalDialogPatch();
    fetchTools().catch((e: any) => setMcpError(e?.message || 'MCP 服务连接失败'));
    useProjectStore.getState().loadActiveProject();
    const h = () => setIsProviderOpen(true);
    window.addEventListener('open-provider-manager', h as any);
    return () => window.removeEventListener('open-provider-manager', h as any);
  }, []);

  // 严格 UI 准入拦截：未选择或创建项目时，禁止停留在任何项目内部功能页，自动重定向至项目看板
  useEffect(() => {
    if (!project && activeTab !== 'projects' && activeTab !== 'config') {
      useProjectStore.getState().setActiveTab('projects');
    }
  }, [project, activeTab]);

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-gray-100 overflow-hidden select-none">
      {/* 1. Universal Top Navigation Header */}
      <Header
        onOpenImport={() => setIsImportOpen(true)}
        onOpenExport={() => setIsExportOpen(true)}
        onOpenMcp={() => setIsMcpOpen(true)}
        onOpenSkills={() => setIsSkillsOpen(true)}
        onOpenConfig={() => useProjectStore.getState().setActiveTab('config')}
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
        {activeTab !== 'config' && (
          <Sidebar
            onOpenMcp={() => setIsMcpOpen(true)}
            onOpenSkills={() => setIsSkillsOpen(true)}
            onOpenProvider={() => setIsProviderOpen(true)}
          />
        )}
        <main className="flex-1 flex flex-col overflow-hidden relative min-w-0">
          {activeTab === 'config' ? (
            <ErrorBoundary name="系统配置中心">
              <ConfigView />
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
        onClose={() => setIsProviderOpen(false)}
      />

      {/* Modern Global Toast / Confirm / Prompt Dialogs */}
      <GlobalDialogContainer />

      {/* 首次启动安装向导（未完成引导时自动弹出；可通过事件重新打开） */}
      <FirstRunWizard />
    </div>
  );
}

export default App;
