@echo off
rem ============================================================
rem  NoteFly launcher - browser edition (compatibility entry).
rem
rem  A .bat is always executed by cmd.exe, and cmd.exe is a
rem  console program: on Windows 11 the default terminal app
rem  (Windows Terminal / ConPTY) hosts it, so a console window
rem  shows up. Script level cannot remove that window - it can
rem  only make it disappear again as fast as possible.
rem
rem  The zero-window entry is the shortcut with the SAME name
rem  next to this file: double-click it directly and no console
rem  window appears at all.
rem
rem  The server is started in the background by the launcher, so
rem  nothing has to stay attached to this console.
rem
rem  Keep this file pure ASCII, and never add "chcp 936" or
rem  "pause" here:
rem    - chcp 936 can hang forever under ConPTY;
rem    - pause keeps the window on screen until a key is pressed;
rem    - running the server in the foreground keeps it alive too.
rem ============================================================
cd /d "%~dp0"
if exist "%~dp0%~n0.lnk" (
  start "" "%~dp0%~n0.lnk"
) else (
  start "" "%~dp0node_modules\electron\dist\electron.exe" . browser
)
exit /b
