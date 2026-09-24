import React, { useState, useEffect, Suspense } from 'react';
import { Header } from './components/navbar/Header';
import { Sidebar } from './components/navbar/Sidebar';
import { AssetLibrary } from './components/asset/AssetLibrary';
import { AgentChatDrawer } from './components/agent/AgentChatDrawer';
import { ExportModal } from './components/export/ExportModal';
import { McpToolsModal } from './components/mcp/McpToolsModal';
import { SkillStudioModal } from './components/skills/SkillStudioModal';
import { SetupView } from './views/setup/SetupView';
import { ProjectDashboard } from './views/ProjectDashboard';
import { AgentModeView } from './views/AgentModeView';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { ProviderManagerModal } from './components/provider/ProviderManagerModal';
import { SelectionPolish } from './components/ui/SelectionPolish';
import { GlobalDialogContainer } from './components/ui/GlobalDialogContainer';
import { FirstRunWizard } from './components/onboarding/FirstRunWizard';
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
  const { project, activeTab, apiError, clearApiError } = useProjectStore();
  const { fetchTools } = useMcpStore();

  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isMcpOpen, setIsMcpOpen] = useState(false);
  const [isSkillsOpen, setIsSkillsOpen] = useState(false);
  const [isProviderOpen, setIsProviderOpen] = useState(false);
  const [providerEdit, setProviderEdit] = useState<any>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);

  useEffect(() => {
    // 启动成功即清掉分片自愈标记，让下一次构建更新仍能自动刷新一次
    try { sessionStorage.removeItem('studio_chunk_reload_once'); } catch {}
    installGlobalDialogPatch();
    fetchTools().catch((e: any) => setMcpError(e?.message || 'MCP 服务连接失败'));
    useProjectStore.getState().loadActiveProject();
    const h = (e: any) => { setProviderEdit(e?.detail?.provider || null); setIsProviderOpen(true); };
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
          {/* ── 精简链路页签路由 ──────────────────────────────────────────────
              只渲染 设置 / 项目看板 / AI 导演 / 素材库 / 创意画布 五个宿主。
              已下线的分镜工作台（studio）/ 3D 片场（director3d）/ 多轨剪辑（timeline）/
              角色设定（characters）由 store 的 normalizeTab 在执行跳转时重定向
              （角色设定 → 素材库，其余 → 画布），此处兜底分支直接落到画布。 */}
          {/* 兜底边界：任何视图运行时崩溃都显示可读错误 + 重试，而不是黑屏/白屏 */}
          <ErrorBoundary name="当前页面">
          {activeTab === 'config' ? (
            <ErrorBoundary name="设置中心">
              <SetupView />
            </ErrorBoundary>
          ) : (!project || activeTab === 'projects') ? (
            <ProjectDashboard />
          ) : activeTab === 'agent' ? (
            <ErrorBoundary name="Agent模式页">
              <AgentModeView />
            </ErrorBoundary>
          ) : activeTab === 'assets' ? (
            <AssetLibrary />
          ) : (
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-gray-500">画布加载中…</div>}>
              <CreativeCanvas />
            </Suspense>
          )}
          </ErrorBoundary>
        </main>
      </div>

      {/* 3. 悬浮导演 Agent（仅当存在有效项目、且不在画布页时启用）
          画布页有专属的右侧 Agent 侧栏（CanvasAgentSidebar），两者共用同一份会话；
          此处加 activeTab 闸门，避免画布上同时出现两个功能重复的导演 Agent 入口。 */}
      {project && activeTab !== 'canvas' && <AgentChatDrawer />}

      {/* 3.1 选区级 AI 润色（多行文本域里选中文字才出现，只替换选区）。
             原先"聚焦就飘一个按钮"的 GlobalAiPolish 已移除：它从不消失、
             无差别命中搜索框/密钥框，且整段覆盖原值 —— 已由字段级
             按钮（AiPolishButton）+ 本浮标两个明确入口取代。 */}
      <SelectionPolish />

      {/* 4. Global Modals */}
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

      {/* Modern Global Toast / Confirm / Prompt Dialogs */}
      <GlobalDialogContainer />

      {/* 首次启动安装向导（未完成引导时自动弹出；可通过事件重新打开） */}
      <FirstRunWizard />
    </div>
  );
}

export default App;
