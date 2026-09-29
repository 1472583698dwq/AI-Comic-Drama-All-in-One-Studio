import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installFrontendErrorHooks } from './utils/frontendLogger'

// 前端错误采集（window.onerror / 未处理 Promise / API 4xx-5xx）→ 回传 storage/logs/studio.log
installFrontendErrorHooks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
