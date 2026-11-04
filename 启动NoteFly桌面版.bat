@echo off
chcp 936 >nul
title NoteFly 桌面版
cd /d "%~dp0"
rem 部分环境会带 ELECTRON_RUN_AS_NODE，导致 Electron 被当作纯 Node 运行而启动失败
set ELECTRON_RUN_AS_NODE=
echo 正在启动 NoteFly 桌面版...
echo 首次启动需要加载 Electron，请稍候（窗口约 10~20 秒出现）
call npx electron .
if errorlevel 1 (
  echo.
  echo [启动失败] 请把上面的报错信息截图反馈。
  pause
)
