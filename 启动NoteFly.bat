@echo off
title NoteFly - 多平台分发工作台
cd /d "%~dp0"
echo ========================================
echo   NoteFly 正在启动...
echo   启动后请访问: http://localhost:3210
echo   关闭本窗口即停止服务
echo ========================================
start "" http://localhost:3210
node server.js
pause
