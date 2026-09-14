import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { MobileCardFlow } from './components/mobile/MobileCardFlow'
import { ScriptImportView } from './views/ScriptImportView'
import { ExportModal } from './components/export/ExportModal'
import { AgentChatDrawer } from './components/agent/AgentChatDrawer'
import { useMcpStore } from './stores/useMcpStore'
import { useProjectStore } from './stores/useProjectStore'

function MobileApp() {
  const { project, apiError, clearApiError } = useProjectStore()
  const { fetchTools } = useMcpStore()
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [isExportOpen, setIsExportOpen] = useState(false)

  useEffect(() => { fetchTools().catch(() => {}); }, [])

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-gray-100 overflow-hidden">
      {/* Top bar — minimal for standalone */}
      <header className="h-12 px-4 flex items-center justify-between bg-surface border-b border-border shrink-0">
        <span className="text-xs font-bold text-white">🎬 AI 漫剧 · 移动端</span>
        <div className="flex items-center space-x-2">
          <button onClick={() => setIsImportOpen(true)} className="px-3 py-1 rounded-lg text-xs font-medium bg-surface-tertiary border border-border text-white">导入小说</button>
          <button onClick={() => setIsExportOpen(true)} className="px-3 py-1 rounded-lg text-xs font-semibold bg-brand text-white">导出</button>
        </div>
      </header>

      {apiError && (
        <div className="mx-3 mt-2 px-3 py-2 rounded bg-red-500/15 border border-red-500/40 text-xs text-red-300 flex items-center justify-between">
          <span className="truncate">⚠️ {apiError}</span>
          <button onClick={clearApiError} className="ml-2 px-2 py-0.5 rounded bg-red-500/30 text-white">×</button>
        </div>
      )}

      {!project ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand to-accent-pink flex items-center justify-center text-3xl">📱</div>
          <h2 className="text-base font-bold text-white">移动端漫剧工坊</h2>
          <p className="text-xs text-gray-400">点击「导入小说」开始，分镜与配音均为真实接口生成</p>
          <button onClick={() => setIsImportOpen(true)} className="px-6 py-2 rounded-xl bg-brand text-white text-sm font-semibold">导入小说</button>
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          <MobileCardFlow standalone onOpenExport={() => setIsExportOpen(true)} />
        </div>
      )}

      <AgentChatDrawer />

      <ScriptImportView isOpen={isImportOpen} onClose={() => setIsImportOpen(false)} />
      <ExportModal isOpen={isExportOpen} onClose={() => setIsExportOpen(false)} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
)
