@echo off
rem ============================================================
rem  Stop NoteFly: kill whatever is listening on port 3210.
rem  (The desktop edition runs the HTTP server inside the
rem  Electron process, so killing the port owner stops it too.)
rem
rem  Keep this file pure ASCII, and never add "chcp 936" or
rem  "pause" here:
rem    - chcp 936 can hang forever under ConPTY;
rem    - pause keeps the window on screen until a key is pressed.
rem ============================================================
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3210" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1
exit /b
