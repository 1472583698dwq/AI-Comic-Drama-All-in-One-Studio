@echo off
chcp 65001 >nul
title MiniMax AI 漫剧 Studio - 双端开发模式
cd /d "%~dp0"

echo ========================================================
echo   🌟 MiniMax AI 漫剧 Studio - 双端开发调试模式
echo ========================================================
echo.

echo [1/2] 启动 Python FastAPI 后端服务 (Port: 8000)...
start "AI漫剧-后端引擎" cmd /k "cd /d "%~dp0server" && python run_server.py"

echo [2/2] 启动 Vite 热更新前端开发服务器 (Port: 5173)...
start "AI漫剧-前端开发" cmd /k "cd /d "%~dp0client" && npm run dev"

timeout /t 3 >nul
start http://localhost:5173
echo.
echo ✅ 开发服务已启动！
