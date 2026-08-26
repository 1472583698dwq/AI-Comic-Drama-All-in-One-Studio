@echo off
title AI Âþ¾ç Studio
cd /d "%~dp0"

taskkill /f /im Studio.exe >nul 2>nul
taskkill /f /im MiniMax_AIÂþ¾çStudio.exe >nul 2>nul
timeout /t 1 /nobreak >nul

if exist "%~dp0dist\Studio\Studio.exe" (
    start "" "%~dp0dist\Studio\Studio.exe"
    exit /b 0
)

if exist "%~dp0dist\MiniMax_AIÂþ¾çStudio\MiniMax_AIÂþ¾çStudio.exe" (
    start "" "%~dp0dist\MiniMax_AIÂþ¾çStudio\MiniMax_AIÂþ¾çStudio.exe"
    exit /b 0
)

if exist "%~dp0launch_desktop_app.py" (
    start "" python "%~dp0launch_desktop_app.py"
    exit /b 0
)

start "AI Studio Server" /min cmd /c "cd /d "%~dp0server" && python run_server.py"
timeout /t 2 >nul
start http://127.0.0.1:8000
exit /b 0
