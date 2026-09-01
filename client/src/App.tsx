import React, { useState, useEffect, Suspense } from 'react';
import { Header } from './components/navbar/Header';
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
import { ProviderManagerModal } from './components/provider/ProviderManagerModal';
import { GlobalAiPolish } from './components/ui/GlobalAiPolish';
const CreativeCanvas = React.lazy(()=> import('./components/canvas/CreativeCanvas').then(m=> ({default: m.CreativeCanvas})));
import { useProjectStore } from './stores/useProjectStore';
import { useMcpStore } from './stores/useMcpStore';

export function App() {
  const { project, activeTab, workspace, platformMode, apiError, clearApiError } = useProjectStore();
  const { fetchTools } = useMcpStore();

  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isMcpOpen, setIsMcpOpen] = useState(false);
  const [isSkillsOpen, setIsSkillsOpen] = useState(false);
  const [isProviderOpen, setIsProviderOpen] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  useEffect(() => {
    fetchTools().catch((e: any) => setMcpError(e?.message || 'MCP 服务连接失败'));
    useProjectStore.getState().loadActiveProject();
    const h = () => setIsProviderOpen(true);
    window.addEventListener('open-provider-manager', h as any);
    return () => window.removeEventListener('open-provider-manager', h as any);
  }, []);

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

      {/* 2. Config View (Universal Fullscreen Tab) */}
      {activeTab === 'config' ? (
        <main className="flex-1 flex flex-col overflow-hidden relative">
          <ConfigView />
        </main>
      ) : workspace === 'creative' ? (
        <main className="flex-1 flex flex-col overflow-hidden relative">
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-gray-500">画布加载中…</div>}>
            <CreativeCanvas />
          </Suspense>
        </main>
      ) : (
        <>
          {/* P0: 项目看板（无需 project 即可访问） */}
          {activeTab === 'projects' && (
            <main className="flex-1 flex flex-col overflow-hidden relative">
              <ProjectDashboard />
            </main>
          )}
          {/* 无项目时的引导：仅在 production 非 projects/assets 时显示 */}
          {!project && activeTab !== 'assets' && activeTab !== 'characters' && activeTab !== 'projects' && (
            <div className="flex-1 flex flex-col items-center justify-center bg-background p-8 text-center space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand to-accent-pink flex items-center justify-center text-3xl shadow-xl shadow-brand/20">
                🎬
              </div>
              <h2 className="text-lg font-bold text-white">选择或创建项目以开始</h2>
              <p className="text-xs text-gray-400 max-w-md">
                项目隔离素材与分镜，支持空白创建、导入小说或导入项目包。素材可设为全局或共享到其他项目。
              </p>
              <div className="flex items-center space-x-3 pt-2">
                <button
                  onClick={() => useProjectStore.getState().setActiveTab('projects')}
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white text-xs font-semibold hover:opacity-90 shadow-lg shadow-brand/20 transition-all"
                >
                  打开项目看板
                </button>
                <button
                  onClick={() => setIsImportOpen(true)}
                  className="px-5 py-2.5 rounded-xl bg-surface-secondary border border-border text-gray-200 hover:text-white hover:border-brand text-xs font-semibold transition-all"
                >
                  导入小说拆解
                </button>
              </div>
            </div>
          )}

          {/* Character Studio - Project Character Management & Turnaround Matrix */}
          {activeTab === 'characters' && (
            <main className="flex-1 flex flex-col overflow-hidden relative">
              <CharacterStudio />
            </main>
          )}

          {/* Asset Library - Global & Project Media Asset Center */}
          {activeTab === 'assets' && (
            <main className="flex-1 flex flex-col overflow-hidden relative">
              <AssetLibrary />
            </main>
          )}

          {/* Main Workspace Layout when project loaded */}
          {project && activeTab !== 'assets' && activeTab !== 'characters' && activeTab !== 'projects' && (
            <main className="flex-1 flex flex-col overflow-hidden relative">
              {platformMode === 'desktop' ? (
                /* Desktop Professional Studio */
                <div className="flex-1 flex flex-col overflow-hidden">
                  {/* Top Workspace Area */}
                  <div className="flex-1 flex overflow-hidden">
                    {activeTab === 'studio' && <ShotInspector />}
                    {activeTab === 'director3d' && <Director3DStage />}
                    {activeTab === 'timeline' && (
                      <div className="flex-1 flex flex-col">
                        <div className="flex-1 flex items-center justify-center bg-surface">
                          <ShotInspector />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Bottom Multi-track Timeline */}
                  <MultiTrackTimeline />
                </div>
              ) : (
                /* Mobile App Card-Flow View (Xiaoyunque Style) — same component, real API */
                <MobileCardFlow onOpenExport={() => setIsExportOpen(true)} />
              )}
            </main>
          )}
        </>
      )}

      {/* 3. Floating Multi-Modal Director Agent */}
      <AgentChatDrawer />

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
    </div>
  );
}

export default App;
