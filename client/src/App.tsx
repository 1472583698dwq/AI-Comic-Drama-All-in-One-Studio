import React, { useState, useEffect } from 'react';
import { Header } from './components/navbar/Header';
import { ShotInspector } from './components/storyboard/ShotInspector';
import { Director3DStage } from './components/director3d/Director3DStage';
import { MultiTrackTimeline } from './components/timeline/MultiTrackTimeline';
import { CharacterStudio } from './components/character/CharacterStudio';
import { MobileCardFlow } from './components/mobile/MobileCardFlow';
import { AgentChatDrawer } from './components/agent/AgentChatDrawer';
import { ScriptImportView } from './views/ScriptImportView';
import { ExportModal } from './components/export/ExportModal';
import { McpToolsModal } from './components/mcp/McpToolsModal';
import { SkillStudioModal } from './components/skills/SkillStudioModal';
import { ConfigView } from './views/ConfigView';
import { useProjectStore } from './stores/useProjectStore';
import { useMcpStore } from './stores/useMcpStore';

export function App() {
  const { project, activeTab, platformMode, apiError, clearApiError } = useProjectStore();
  const { fetchTools } = useMcpStore();

  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isMcpOpen, setIsMcpOpen] = useState(false);
  const [isSkillsOpen, setIsSkillsOpen] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  useEffect(() => {
    fetchTools().catch((e: any) => setMcpError(e?.message || 'MCP 服务连接失败'));
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
      ) : (
        <>
          {/* Empty state when no project yet */}
          {!project && (
            <div className="flex-1 flex flex-col items-center justify-center bg-background p-8 text-center space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand to-accent-pink flex items-center justify-center text-3xl shadow-xl shadow-brand/20">
                🎬
              </div>
              <h2 className="text-lg font-bold text-white">开始你的 AI 漫剧创作</h2>
              <p className="text-xs text-gray-400 max-w-md">
                点击「导入小说」粘贴章节文本，大模型将真实拆解为角色与分镜。支持 MiniMax、DeepSeek、阿里通义千问、ComfyUI、剪映等全生态配置。
              </p>
              <div className="flex items-center space-x-3 pt-2">
                <button
                  onClick={() => setIsImportOpen(true)}
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white text-xs font-semibold hover:opacity-90 shadow-lg shadow-brand/20 transition-all"
                >
                  导入小说拆解
                </button>
                <button
                  onClick={() => useProjectStore.getState().setActiveTab('config')}
                  className="px-5 py-2.5 rounded-xl bg-surface-secondary border border-border text-gray-200 hover:text-white hover:border-brand text-xs font-semibold transition-all"
                >
                  ⚙️ 配置 API Key 与服务
                </button>
              </div>
              <p className="text-[10px] text-gray-500 pt-2">
                提示：支持自定义 MiniMax / DeepSeek / 通义千问 / ComfyUI / 硅基流动 / 剪映草稿目录
              </p>
            </div>
          )}

          {/* Main Workspace Layout when project loaded */}
          {project && (
            <main className="flex-1 flex flex-col overflow-hidden relative">
              {platformMode === 'desktop' ? (
                /* Desktop Professional Studio */
                <div className="flex-1 flex flex-col overflow-hidden">
                  {/* Top Workspace Area */}
                  <div className="flex-1 flex overflow-hidden">
                    {activeTab === 'studio' && <ShotInspector />}
                    {activeTab === 'director3d' && <Director3DStage />}
                    {activeTab === 'characters' && <CharacterStudio />}
                    {activeTab === 'timeline' && (
                      <div className="flex-1 flex flex-col">
                        <div className="flex-1 flex items-center justify-center bg-[#07070A]">
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
    </div>
  );
}

export default App;
